/**
 * Gateway audit wiring (Fastify).
 *
 * `@reaatech/mcp-gateway-audit` ships audit primitives (event factory,
 * tamper-evident hash chaining, composite/console/file loggers) plus a Fastify
 * plugin (`@reaatech/mcp-gateway-audit/fastify` → `fastifyAudit`) that records a
 * `tool.executed`-style event per request as a `preHandler` hook. The plugin
 * defaults to a SILENT sink; to land events in MediaLocker's `audit_log` table
 * we supply our own `logger`:
 *
 *  1. `DbAuditLogger` satisfies the package's `AuditLogger` interface and writes
 *     gateway `AuditEvent`s into MediaLocker's existing `audit_log` table (§6).
 *  2. It is wrapped with `TamperEvidentLogger` (hash chain) inside a
 *     `CompositeAuditLogger` that also mirrors to `ConsoleAuditLogger` in dev.
 *
 * `getGatewayAuditLogger()` is passed to `fastifyAudit({ logger })` in index.ts.
 */
import type postgres from "postgres";
import {
  CompositeAuditLogger,
  ConsoleAuditLogger,
  TamperEvidentLogger,
  type AuditEvent,
  type AuditLogger,
} from "@reaatech/mcp-gateway-audit";
import { createLogger } from "@medialocker/observability";
import { getConfig } from "@medialocker/config";

const logger = createLogger("mcp:gateway-audit");

type Sql = ReturnType<typeof postgres>;

/** Writes gateway audit events into the MediaLocker `audit_log` table. */
class DbAuditLogger implements AuditLogger {
  constructor(private readonly sql: Sql) {}

  log(event: AuditEvent): void {
    // Best-effort; audit must never break a request.
    void this.sql`
      INSERT INTO audit_log (org_id, actor, action, target, ip, ts)
      VALUES (
        ${event.tenantId ?? null},
        ${event.userId ?? "mcp"},
        ${event.eventType},
        ${event.tool ?? null},
        ${event.ipAddress ?? null},
        ${event.timestamp}
      )
    `.catch((err: unknown) => logger.error({ err }, "audit_log insert failed"));
  }
}

let _audit: AuditLogger | null = null;

export function initGatewayAudit(sql: Sql): AuditLogger {
  const composite = new CompositeAuditLogger();
  // Tamper-evident chain over the DB sink.
  composite.addLogger(new TamperEvidentLogger(new DbAuditLogger(sql)));
  if (getConfig().NODE_ENV !== "production") {
    composite.addLogger(new ConsoleAuditLogger());
  }
  _audit = composite;
  return composite;
}

/** The audit logger to hand to `fastifyAudit({ logger })`. */
export function getGatewayAuditLogger(): AuditLogger | null {
  return _audit;
}
