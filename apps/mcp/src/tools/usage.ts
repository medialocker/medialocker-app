import { z } from "zod";
import { addCapacity, removeCapacity } from "@medialocker/billing";
import { ToolHandlerContext } from "./types.js";

export function registerUsageTools(registerTool: (tool: any) => void): void {
  registerTool({
    name: "get_usage",
    description: "Get current storage usage, egress stats, and request counts for the organization.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      z.object({}).parse(rawParams);
      const cap = await sql`
        SELECT allocated_bytes, used_bytes, auto_enabled FROM capacity WHERE org_id = ${auth.orgId}
      `;

      if (cap.length === 0) {
        return {
          usedBytes: "0",
          allocatedBytes: "0",
          freeBytes: "0",
          usedGb: 0,
          allocatedGb: 0,
          freeGb: 0,
          egressBytes: 0,
          requests: 0,
        };
      }

      const used = BigInt(cap[0]!.used_bytes);
      const allocated = BigInt(cap[0]!.allocated_bytes);
      const free = allocated > used ? allocated - used : 0n;

      const egressRow = await sql`
        SELECT COALESCE(SUM(egress_bytes), 0) as total_egress
        FROM usage_rollups WHERE org_id = ${auth.orgId}
      `;
      const reqRow = await sql`
        SELECT COALESCE(SUM(request_count), 0) as total_req
        FROM usage_rollups WHERE org_id = ${auth.orgId}
      `;

      return {
        usedBytes: used.toString(),
        allocatedBytes: allocated.toString(),
        freeBytes: free.toString(),
        usedGb: Number(used) / 1e9,
        allocatedGb: Number(allocated) / 1e9,
        freeGb: Number(free) / 1e9,
        egressBytes: Number(egressRow[0]!.total_egress),
        requests: parseInt(reqRow[0]!.total_req, 10),
        autoCapacityEnabled: cap[0]!.auto_enabled,
      };
    },
  });

  registerTool({
    name: "get_billing_info",
    description: "Get current plan, add-on capacity, and billing details for the organization.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      z.object({}).parse(rawParams);
      const sub = await sql`
        SELECT s.id, s.stripe_subscription_id, s.status, s.current_period_end,
               p.name as plan_name, p.included_gb, p.per_gb_price_cents
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.org_id = ${auth.orgId}
        ORDER BY s.created_at DESC
        LIMIT 1
      `;

      if (sub.length === 0) {
        throw new Error("No subscription found");
      }

      const addons = await sql`
        SELECT id, gb, created_at, prorated FROM billing_addons
        WHERE org_id = ${auth.orgId}
        ORDER BY created_at DESC
      `;

      const cap = await sql`
        SELECT allocated_bytes, used_bytes, increment_gb, threshold_pct, max_monthly_spend_cents
        FROM capacity WHERE org_id = ${auth.orgId}
      `;

      return {
        plan: {
          name: sub[0]!.plan_name,
          includedGb: parseInt(sub[0]!.included_gb, 10),
          perGbPriceCents: parseInt(sub[0]!.per_gb_price_cents, 10),
          status: sub[0]!.status,
          currentPeriodEnd: sub[0]!.current_period_end,
        },
        addons: addons.map((a: any) => ({ ...a, gb: parseInt(a.gb, 10) })),
        capacity: cap[0]
          ? {
              allocatedGb: Number(BigInt(cap[0].allocated_bytes)) / 1e9,
              usedGb: Number(BigInt(cap[0].used_bytes)) / 1e9,
              autoIncrementGb: cap[0].increment_gb,
              autoThresholdPct: cap[0].threshold_pct,
              maxMonthlySpendCents: cap[0].max_monthly_spend_cents,
            }
          : null,
      };
    },
  });

  registerTool({
    name: "manage_capacity",
    description: "Add/remove capacity or configure auto-capacity settings. Action: 'add', 'remove', or 'auto'. On billed (Stripe) deployments, 'add' creates a prorated capacity add-on and 'remove' cancels whole add-ons (newest first) until at least `gb` is freed, so removal may free slightly more than requested.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "auto"], description: "Action to perform" },
        gb: { type: "number", description: "GB to add or remove (for add/remove actions)" },
        enabled: { type: "boolean", description: "Enable/disable auto-capacity (for auto action)" },
        incrementGb: { type: "number", description: "GB to auto-add when threshold reached" },
        thresholdPct: { type: "number", description: "Usage percentage threshold to trigger auto-add" },
        maxMonthlySpendCents: { type: "number", description: "Max monthly automated spend in cents" },
      },
      required: ["action"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth, config }: ToolHandlerContext) => {
      // Capacity changes cost money (Stripe add-ons) and reshape quota — gate on
      // admin so a read/write credential cannot add/remove capacity or change
      // auto-capacity settings.
      if (!auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: admin");
      }

      const schema = z.object({
        action: z.enum(["add", "remove", "auto"]),
        gb: z.number().positive().optional(),
        enabled: z.boolean().optional(),
        incrementGb: z.number().optional(),
        thresholdPct: z.number().optional(),
        maxMonthlySpendCents: z.number().optional(),
      });
      const { action, gb, enabled, incrementGb, thresholdPct, maxMonthlySpendCents } = schema.parse(rawParams);

      // SaaS deployments bill through Stripe; self-host has no billing. Capacity
      // changes must flow through @medialocker/billing whenever Stripe is
      // configured so the subscription stays in sync and capacity is never
      // granted (or dropped) for free (§8/§26). Only when there is no Stripe key
      // do we resize the DB counter directly.
      const stripeConfigured = Boolean(config.STRIPE_SECRET_KEY);

      const capacity = await sql`
        SELECT allocated_bytes, used_bytes FROM capacity WHERE org_id = ${auth.orgId}
      `;
      if (capacity.length === 0) {
        throw new Error("No capacity record found");
      }

      switch (action) {
        case "add": {
          if (!gb || gb <= 0) throw new Error("gb must be a positive number");

          if (stripeConfigured) {
            const res = await addCapacity(sql, auth.orgId, gb, true);
            if (!res.success) throw new Error(res.reason ?? "Could not add capacity");
            const after = await sql`SELECT allocated_bytes FROM capacity WHERE org_id = ${auth.orgId}`;
            void sql`INSERT INTO audit_log (org_id, actor, action, target, ip, ts) VALUES (${auth.orgId}, ${auth.userId ?? "mcp"}, 'manage_capacity:add', ${gb + 'GB'}, null, now())`.catch(() => {});
            return {
              addedGb: gb,
              newAllocatedGb: Number(BigInt(after[0]!.allocated_bytes)) / 1e9,
              costCents: res.cost,
              stripeItemId: res.stripeItemId,
            };
          }

          const addBytes = BigInt(gb) * 1_000_000_000n;
          const newAlloc = BigInt(capacity[0]!.allocated_bytes) + addBytes;
          await sql`UPDATE capacity SET allocated_bytes = ${newAlloc.toString()} WHERE org_id = ${auth.orgId}`;
          void sql`INSERT INTO audit_log (org_id, actor, action, target, ip, ts) VALUES (${auth.orgId}, ${auth.userId ?? "mcp"}, 'manage_capacity:add', ${gb + 'GB'}, null, now())`.catch(() => {});
          return { addedGb: gb, newAllocatedGb: Number(newAlloc) / 1e9 };
        }

        case "remove": {
          if (!gb || gb <= 0) throw new Error("gb must be a positive number");

          if (stripeConfigured) {
            // Billed capacity lives in discrete Stripe add-on items, so we cancel
            // whole add-ons (newest first) until at least `gb` is freed. Each
            // removeCapacity cancels the Stripe item, refunds the cycle spend and
            // enforces the §8 shrink guard before mutating anything. Because we can
            // only drop whole add-ons, this may free slightly more than requested.
            const addons = await sql<{ id: string; gb: number }[]>`
              SELECT id, gb FROM billing_addons
              WHERE org_id = ${auth.orgId}
              ORDER BY created_at DESC
            `;
            if (addons.length === 0) {
              throw new Error(
                "No removable capacity add-ons. To reduce below your plan's included storage, downgrade the plan instead.",
              );
            }

            let removedGb = 0;
            const removedAddonIds: string[] = [];
            let warning: string | undefined;
            for (const addon of addons) {
              if (removedGb >= gb) break;
              const res = await removeCapacity(sql, auth.orgId, addon.id);
              if (!res.success) {
                warning = res.reason;
                break;
              }
              removedGb += Number(addon.gb);
              removedAddonIds.push(addon.id);
            }
            if (removedGb === 0) throw new Error(warning ?? "Could not remove capacity");

            const after = await sql`SELECT allocated_bytes FROM capacity WHERE org_id = ${auth.orgId}`;
            void sql`INSERT INTO audit_log (org_id, actor, action, target, ip, ts) VALUES (${auth.orgId}, ${auth.userId ?? "mcp"}, 'manage_capacity:remove', ${gb + 'GB'}, null, now())`.catch(() => {});
            return {
              removedGb,
              requestedGb: gb,
              removedAddonIds,
              newAllocatedGb: Number(BigInt(after[0]!.allocated_bytes)) / 1e9,
              ...(warning ? { warning } : {}),
            };
          }

          const removeBytes = BigInt(gb) * 1_000_000_000n;
          const currentAlloc = BigInt(capacity[0]!.allocated_bytes);
          const currentUsed = BigInt(capacity[0]!.used_bytes);
          const newAlloc = currentAlloc - removeBytes;

          if (newAlloc < 0n) {
            throw new Error(`Cannot remove more capacity than currently allocated (${Number(currentAlloc) / 1e9} GB allocated). Requested removal of ${gb} GB would result in negative allocation.`);
          }

          if (newAlloc < currentUsed) {
            throw new Error(`Cannot reduce capacity below current usage (${Number(currentUsed) / 1e9} GB used). Free up ${Number(currentUsed - newAlloc) / 1e9} GB first.`);
          }

          await sql`UPDATE capacity SET allocated_bytes = ${newAlloc.toString()} WHERE org_id = ${auth.orgId}`;
          void sql`INSERT INTO audit_log (org_id, actor, action, target, ip, ts) VALUES (${auth.orgId}, ${auth.userId ?? "mcp"}, 'manage_capacity:remove', ${gb + 'GB'}, null, now())`.catch(() => {});
          return { removedGb: gb, newAllocatedGb: Number(newAlloc) / 1e9 };
        }

        case "auto": {
          if (enabled === undefined) throw new Error("enabled field is required for auto action");
          await sql`
            UPDATE capacity
            SET auto_enabled = ${enabled},
                increment_gb = ${incrementGb ?? null},
                threshold_pct = ${thresholdPct ?? null},
                max_monthly_spend_cents = ${maxMonthlySpendCents ?? null}
            WHERE org_id = ${auth.orgId}
          `;
          void sql`INSERT INTO audit_log (org_id, actor, action, target, ip, ts) VALUES (${auth.orgId}, ${auth.userId ?? "mcp"}, 'manage_capacity:auto', ${enabled ? 'enabled' : 'disabled'}, null, now())`.catch(() => {});
          return { autoCapacity: { enabled, incrementGb, thresholdPct, maxMonthlySpendCents } };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  });
}
