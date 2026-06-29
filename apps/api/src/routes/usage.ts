import { FastifyInstance } from "fastify";
import { z } from "zod";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";
import { STRIPE_API_VERSION, addCapacity, changePlan } from "@medialocker/billing";
import { acquireOrgLock } from "@medialocker/core";

const addCapacitySchema = z.object({
  gb: z.number().int().min(1).max(100000),
});

const downgradeSchema = z.object({
  tierKey: z.string().min(1).max(64),
});

const autoCapacitySchema = z
  .object({
    enabled: z.boolean(),
    incrementGb: z.number().int().min(1).max(10000).optional(),
    thresholdPct: z.number().min(1).max(50).optional(),
    maxMonthlySpendCents: z.number().int().min(0).optional(),
  })
  // C9: when auto-capacity is ON, ALL three knobs must be set — otherwise the
  // auto-add path reads NULLs: a NULL threshold coerces to 0 (adds on every
  // over-quota write) and a NULL spend cap bypasses the spend guard (unbounded
  // automated spend). The frontend always sends all four fields.
  .refine(
    (v) =>
      !v.enabled ||
      (v.incrementGb !== undefined &&
        v.thresholdPct !== undefined &&
        v.maxMonthlySpendCents !== undefined &&
        v.maxMonthlySpendCents > 0),
    {
      path: ["enabled"],
      message:
        "incrementGb, thresholdPct, and a positive maxMonthlySpendCents are all required when auto-capacity is enabled",
    },
  );

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/usage",
    { preHandler: [validate({}), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;

      const cap = await sql<{
        allocated_bytes: string;
        used_bytes: string;
        auto_enabled: boolean;
        increment_gb: string;
        threshold_pct: number;
        max_monthly_spend_cents: number | null;
        spend_this_cycle_cents: number;
      }[]>`
        SELECT allocated_bytes, used_bytes, auto_enabled,
               increment_gb, threshold_pct, max_monthly_spend_cents, spend_this_cycle_cents
        FROM capacity WHERE org_id = ${auth.orgId}
      `;

      const objCountRow = await sql<{ count: string }[]>`
        SELECT COUNT(o.id)::text as count
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;
      const objectCount = parseInt(objCountRow[0]!.count, 10);

      if (cap.length === 0) {
        return {
          used: "0",
          allocated: "0",
          free: "0",
          usedGb: 0,
          allocatedGb: 0,
          freeGb: 0,
          egress: 0,
          requests: 0,
          objectCount,
          autoCapacity: {
            enabled: false,
            incrementGb: 10,
            thresholdPct: 80,
            maxMonthlySpendCents: 0,
            spendThisCycleCents: 0,
          },
        };
      }

      const used = BigInt(cap[0]!.used_bytes);
      const allocated = BigInt(cap[0]!.allocated_bytes);
      const free = allocated > used ? allocated - used : 0n;

      const egressRow = await sql<{ total_egress: string }[]>`
        SELECT COALESCE(SUM(egress_bytes), 0)::text as total_egress
        FROM usage_rollups WHERE org_id = ${auth.orgId}
      `;
      const egress = BigInt(egressRow[0]!.total_egress);
      const reqRow = await sql<{ total_req: string }[]>`
        SELECT COALESCE(SUM(request_count), 0)::text as total_req
        FROM usage_rollups WHERE org_id = ${auth.orgId}
      `;

      return {
        used: used.toString(),
        allocated: allocated.toString(),
        free: free.toString(),
        usedGb: Number(used) / 1e9,
        allocatedGb: Number(allocated) / 1e9,
        freeGb: Number(free) / 1e9,
        egress: Number(egress),
        requests: parseInt(reqRow[0]!.total_req, 10),
        objectCount,
        autoCapacity: {
          enabled: cap[0]!.auto_enabled,
          incrementGb: Number(cap[0]!.increment_gb),
          thresholdPct: cap[0]!.threshold_pct,
          maxMonthlySpendCents: cap[0]!.max_monthly_spend_cents ?? 0,
          spendThisCycleCents: cap[0]!.spend_this_cycle_cents,
        },
      };
    },
  );

  app.get(
    "/usage/history",
    { preHandler: [validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }) }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const q = (request as any).validatedQuery as { days: number; limit: number; offset: number };

      const rows = await sql`
        SELECT period, stored_bytes_max, egress_bytes, request_count
        FROM usage_rollups
        WHERE org_id = ${auth.orgId}
          AND period >= now() - ${`${q.days} days`}::interval
        ORDER BY period ASC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `;

      return { history: rows };
    },
  );

  app.get(
    "/usage/events",
    { preHandler: [validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30), limit: z.coerce.number().int().min(1).max(1000).default(100), offset: z.coerce.number().int().min(0).default(0) }) }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const q = (request as any).validatedQuery as { days: number; limit: number; offset: number };

      const rows = await sql`
        SELECT id, type, bytes, ts
        FROM usage_events
        WHERE org_id = ${auth.orgId}
          AND ts >= now() - ${`${q.days} days`}::interval
        ORDER BY ts DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `;

      return { events: rows };
    },
  );

  app.get(
    "/billing/subscription",
    { preHandler: [validate({}), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;

      const sub = await sql<{
        id: string;
        stripe_subscription_id: string | null;
        plan_id: string;
        status: string;
        current_period_end: string;
        plan_name: string;
        plan_included_gb: string;
        plan_price_cents: string;
      }[]>`
        SELECT s.id, s.stripe_subscription_id, s.plan_id, s.status, s.current_period_end,
               p.name as plan_name, p.included_gb as plan_included_gb, p.per_gb_price_cents as plan_price_cents
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.org_id = ${auth.orgId}
        ORDER BY s.created_at DESC
        LIMIT 1
      `;

      if (sub.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "No subscription found" } });
      }

      const addons = await sql`
        SELECT id, stripe_item_id, gb, created_at, prorated FROM billing_addons
        WHERE org_id = ${auth.orgId}
        ORDER BY created_at DESC
      `;

      return {
        subscription: { ...sub[0], planIncludedGb: parseInt(sub[0]!.plan_included_gb, 10), planPriceCents: parseInt(sub[0]!.plan_price_cents, 10) },
        addons,
      };
    },
  );

  app.post(
    "/billing/capacity/add",
    { preHandler: [validate({ body: addCapacitySchema }), requireScope("admin")] },
    async (request, reply) => {
      const { sql, auth, config: cfg } = request;
      const { gb } = request.body as z.infer<typeof addCapacitySchema>;

      const capacity = await sql<{ allocated_bytes: string; used_bytes: string }[]>`
        SELECT allocated_bytes, used_bytes FROM capacity WHERE org_id = ${auth.orgId}
      `;
      if (capacity.length === 0) {
        return reply.status(400).send({ error: { code: "BadRequest", message: "No capacity record found" } });
      }

      // SaaS (Stripe configured): go through the billed path so the dashboard
      // "add capacity" creates the Stripe add-on item + `billing_addons` row and
      // honours the max-spend cap — capacity is never granted for free (§8/§26).
      // Self-host (no Stripe): there is no billing, so resize capacity directly.
      if (cfg.STRIPE_SECRET_KEY) {
        const res = await addCapacity(sql, auth.orgId, gb, true);
        if (!res.success) {
          const overSpend = /max monthly spend/i.test(res.reason ?? "");
          return reply.status(overSpend ? 402 : 400).send({
            error: { code: overSpend ? "SpendCapExceeded" : "CapacityAddFailed", message: res.reason ?? "Could not add capacity" },
          });
        }
        const after = await sql<{ allocated_bytes: string }[]>`
          SELECT allocated_bytes FROM capacity WHERE org_id = ${auth.orgId}
        `;
        await sql`
          INSERT INTO audit_log (org_id, actor, action, target, ip)
          VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'capacity.add', ${`${gb}GB`}, ${request.ip})
        `;
        return reply.status(200).send({
          addedGb: gb,
          newAllocatedGb: Number(BigInt(after[0]!.allocated_bytes)) / 1e9,
          costCents: res.cost,
          stripeItemId: res.stripeItemId,
          message: `Added ${gb} GB of capacity`,
        });
      }

      // C13: wrap self-hosted capacity add in an advisory-locked transaction
      // so concurrent adds don't race. Also enforce max capacity — the new
      // allocated must not exceed plan.included_gb + active add-ons.
      await sql.begin(async (tx) => {
        await acquireOrgLock(tx, auth.orgId);

        const planRows = await tx<{ included_gb: string }[]>`
          SELECT p.included_gb
            FROM subscriptions s JOIN plans p ON p.id = s.plan_id
           WHERE s.org_id = ${auth.orgId}
           ORDER BY s.created_at DESC
           LIMIT 1
        `;
        const addonRows = await tx<{ total_gb: string }[]>`
          SELECT COALESCE(SUM(gb), 0)::text AS total_gb FROM billing_addons WHERE org_id = ${auth.orgId}
        `;
        const maxGb = Number(planRows[0]?.included_gb ?? 0) + Number(addonRows[0]?.total_gb ?? 0);
        const maxBytes = BigInt(maxGb) * 1_000_000_000n;

        const addBytes = BigInt(gb) * 1_000_000_000n;

        const incremented = await tx<{ allocated_bytes: string }[]>`
          UPDATE capacity
             SET allocated_bytes = allocated_bytes + ${addBytes.toString()}::bigint
           WHERE org_id = ${auth.orgId}
             AND allocated_bytes + ${addBytes.toString()}::bigint <= ${maxBytes.toString()}::bigint
           RETURNING allocated_bytes
        `;

        if (incremented.length === 0) {
          throw new Error(`Adding ${gb} GB would exceed the maximum allowed capacity of ${maxGb} GB`);
        }

        const newAllocated = BigInt(incremented[0]!.allocated_bytes);
        await tx`
          INSERT INTO audit_log (org_id, actor, action, target, ip)
          VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'capacity.add', ${`${gb}GB`}, ${request.ip})
        `;

        reply.status(200).send({
          addedGb: gb,
          newAllocatedGb: Number(newAllocated) / 1e9,
          message: `Added ${gb} GB of capacity`,
        });
      });
    },
  );

  app.post(
    "/billing/downgrade",
    { preHandler: [validate({ body: downgradeSchema }), requireScope("admin")] },
    async (request, reply) => {
      const { sql, auth, config: cfg } = request;
      const { tierKey } = request.body as z.infer<typeof downgradeSchema>;

      // SaaS (Stripe configured): swap the Stripe subscription price too, so the
      // plan change is actually billed — not just reflected in our DB. The §8
      // shrink guard lives inside `changePlan` and surfaces as DowngradeBlocked.
      if (cfg.STRIPE_SECRET_KEY) {
        const res = await changePlan(sql, auth.orgId, tierKey);
        if (!res.success) {
          const statusByCode: Record<string, number> = {
            DowngradeBlocked: 409,
            NotFound: 404,
            NoSubscription: 400,
            NotConfigured: 400,
            StripeError: 502,
          };
          return reply.status(statusByCode[res.code ?? "StripeError"] ?? 400).send({
            error: { code: res.code ?? "PlanChangeFailed", message: res.reason ?? "Could not change plan" },
          });
        }
        await sql`
          INSERT INTO audit_log (org_id, actor, action, target, ip)
          VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'plan.change', ${tierKey}, ${request.ip})
        `;
        return {
          tierKey,
          planName: res.planName,
          newAllocatedGb: Number(res.newAllocatedBytes!) / 1e9,
          message: `Downgraded to ${res.planName}`,
        };
      }

      // Self-host (no Stripe): no billing to sync — resize capacity DB-side only.
      const planRows = await sql<{ id: string; name: string; included_gb: string }[]>`
        SELECT id, name, included_gb FROM plans WHERE tier_key = ${tierKey} LIMIT 1
      `;
      if (planRows.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Unknown plan tier" } });
      }
      const plan = planRows[0]!;

      const cap = await sql<{ used_bytes: string }[]>`
        SELECT used_bytes FROM capacity WHERE org_id = ${auth.orgId}
      `;
      if (cap.length === 0) {
        return reply.status(400).send({ error: { code: "BadRequest", message: "No capacity record found" } });
      }

      // allocated after downgrade = new plan's included GB + bytes from active add-ons.
      const addonRows = await sql<{ total_gb: string }[]>`
        SELECT COALESCE(SUM(gb), 0)::text as total_gb FROM billing_addons WHERE org_id = ${auth.orgId}
      `;
      const includedBytes = BigInt(plan.included_gb) * 1_000_000_000n;
      const addonBytes = BigInt(addonRows[0]!.total_gb) * 1_000_000_000n;
      const targetAllocated = includedBytes + addonBytes;
      const used = BigInt(cap[0]!.used_bytes);

      // Shrink guard (§8): never let allocated drop below what is actually stored.
      if (targetAllocated < used) {
        const freeGb = Math.ceil(Number(used - targetAllocated) / 1e9);
        return reply.status(409).send({
          error: {
            code: "DowngradeBlocked",
            message: `This plan holds less than your current usage. Free ${freeGb} GB before downgrading.`,
          },
        });
      }

      // Serialize concurrent downgrades for this org (advisory xact lock) and audit
      // the change — the two UPDATEs were previously separate, unaudited, and could
      // race on allocated_bytes. (C11)
      await sql.begin(async (tx) => {
        await acquireOrgLock(tx, auth.orgId);
        await tx`UPDATE subscriptions SET plan_id = ${plan.id} WHERE org_id = ${auth.orgId}`;
        await tx`UPDATE capacity SET allocated_bytes = ${targetAllocated.toString()}::bigint WHERE org_id = ${auth.orgId}`;
        await tx`
          INSERT INTO audit_log (org_id, actor, action, target, ip)
          VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'plan.downgrade', ${tierKey}, ${request.ip})
        `;
      });

      return {
        tierKey,
        planName: plan.name,
        newAllocatedGb: Number(targetAllocated) / 1e9,
        message: `Downgraded to ${plan.name}`,
      };
    },
  );

  app.put(
    "/billing/capacity/auto",
    { preHandler: [validate({ body: autoCapacitySchema }), requireScope("admin")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { enabled, incrementGb, thresholdPct, maxMonthlySpendCents } = request.body as z.infer<typeof autoCapacitySchema>;

      await sql`
        UPDATE capacity
        SET auto_enabled = ${enabled},
            increment_gb = ${incrementGb ?? null},
            threshold_pct = ${thresholdPct ?? null},
            max_monthly_spend_cents = ${maxMonthlySpendCents ?? null}
        WHERE org_id = ${auth.orgId}
      `;

      // 9.12: audit auto-capacity policy changes alongside other capacity mutations.
      await sql`
        INSERT INTO audit_log (org_id, actor, action, target, ip)
        VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'capacity.auto', ${enabled ? "enabled" : "disabled"}, ${request.ip})
      `;

      return {
        autoCapacity: { enabled, incrementGb, thresholdPct, maxMonthlySpendCents },
      };
    },
  );

  app.get(
    "/billing/portal",
    { preHandler: [validate({}), requireScope("admin")] },
    async (request, reply) => {
      const { sql, auth, config: cfg } = request;

      if (!cfg.STRIPE_SECRET_KEY || !cfg.STRIPE_PORTAL_CONFIG_ID) {
        return reply.status(501).send({
          error: { code: "NotImplemented", message: "Stripe Customer Portal requires STRIPE_SECRET_KEY and STRIPE_PORTAL_CONFIG_ID" },
        });
      }

      const sub = await sql<{ stripe_customer_id: string | null }[]>`
        SELECT stripe_customer_id FROM subscriptions
        WHERE org_id = ${auth.orgId} AND stripe_customer_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `;

      if (sub.length === 0 || !sub[0]!.stripe_customer_id) {
        return reply.status(404).send({
          error: { code: "NotFound", message: "No Stripe customer found for this organization" },
        });
      }

      const StripeLib = await import("stripe");
      const stripe = new StripeLib.default(cfg.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

      const session = await stripe.billingPortal.sessions.create({
        customer: sub[0]!.stripe_customer_id,
        configuration: cfg.STRIPE_PORTAL_CONFIG_ID,
        return_url: `https://app.${cfg.PUBLIC_BASE_DOMAIN}/billing`,
      });

      return { url: session.url };
    },
  );

  app.get(
    "/billing/invoices",
    { preHandler: [validate({}), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth, config: cfg } = request;

      if (!cfg.STRIPE_SECRET_KEY) {
        return reply.status(501).send({
          error: { code: "NotImplemented", message: "Invoices require Stripe configuration" },
        });
      }

      const sub = await sql<{ stripe_customer_id: string | null }[]>`
        SELECT stripe_customer_id FROM subscriptions
        WHERE org_id = ${auth.orgId} AND stripe_customer_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `;

      if (sub.length === 0 || !sub[0]!.stripe_customer_id) {
        return reply.status(404).send({
          error: { code: "NotFound", message: "No Stripe customer found" },
        });
      }

      const stripe = await importStripe(cfg.STRIPE_SECRET_KEY);
      const stripeInvoices = await stripe.invoices.list({
        customer: sub[0]!.stripe_customer_id,
        limit: 24,
      });

      return {
        invoices: stripeInvoices.data.map((inv) => ({
          id: inv.id,
          date: new Date(inv.created * 1000).toISOString(),
          amount: inv.total / 100,
          status: inv.status ?? "unknown",
          url: inv.hosted_invoice_url ?? "",
        })),
      };
    },
  );
}

async function importStripe(key: string) {
  const StripeLib = await import("stripe");
  return new StripeLib.default(key, { apiVersion: STRIPE_API_VERSION });
}
