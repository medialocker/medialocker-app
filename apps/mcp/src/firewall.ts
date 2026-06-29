/**
 * Tool-use firewall for destructive MediaLocker MCP tools.
 *
 * Gates `delete_object`, `delete_bucket`, and `purge` (plan §12) with the
 * `@reaatech/tool-use-firewall-*` stack:
 *
 *  - `-config`   — `policyConfigSchema` builds/validates the destructive-op policy
 *                  (default allow for everything, with explicit BLOCK/APPROVAL
 *                  rules + an argument-validation rule for `purge.confirm`).
 *  - `-policies` — `PolicyEngine` evaluates the rules (ALLOW / BLOCK /
 *                  APPROVAL_REQUIRED); `ArgumentValidator` enforces arg shape.
 *  - `-core`     — `createRequestContext`, `PolicyViolationError`,
 *                  `ValidationError`, `ApprovalRequiredError`.
 *  - `-audit`    — `AuditLogger` records every firewall decision (ALLOW/BLOCK).
 *
 * Destructive tools default to APPROVAL_REQUIRED (fail-closed when the approval
 * server is not stood up). The must-haves — policy enforcement, argument
 * validation, and audit — are always active.
 *
 * The existing per-tool scope checks (delete/admin) remain in the tool handlers
 * as defense in depth; this firewall is an additional, centralized gate.
 */
import {
  createRequestContext,
  PolicyViolationError,
  ValidationError,
} from "@reaatech/tool-use-firewall-core";
import { policyConfigSchema } from "@reaatech/tool-use-firewall-config";
import { PolicyEngine, ArgumentValidator } from "@reaatech/tool-use-firewall-policies";
import { AuditLogger } from "@reaatech/tool-use-firewall-audit";
import { createLogger } from "@medialocker/observability";

const logger = createLogger("mcp:firewall");

export const DESTRUCTIVE_TOOL_NAMES = ["delete_object", "delete_bucket", "purge"] as const;
export type DestructiveToolName = (typeof DESTRUCTIVE_TOOL_NAMES)[number];

/**
 * Destructive-operation policy. Built in-code and validated by the config
 * schema so it carries the same guarantees as a loaded YAML policy.
 *
 * `enableApprovals` toggles whether destructive tools require human approval
 * (defaults to approval_required in production — fail-closed).
 */
function buildPolicy(enableApprovals: boolean) {
  return policyConfigSchema.parse({
    version: "1",
    settings: {
      read_only: false,
      // Default allow: non-destructive tools pass straight through.
      default_action: "allow",
      audit_level: "full",
      dry_run: false,
    },
    rules: [
      {
        // Argument validation (via a policy condition): purge must carry an
        // explicit confirm='DELETE'. Negative-lookahead BLOCKs any other value.
        // Higher priority than the destructive-allow rule below. Enforced
        // centrally by the firewall in addition to the handler's own guard.
        id: "purge-requires-confirm",
        type: "block",
        tools: ["purge"],
        priority: 200,
        conditions: [{ argument: "confirm", pattern: "^(?!DELETE$)" }],
        description: "purge requires confirm='DELETE'",
      },
      {
        id: "destructive-tools",
        type: enableApprovals ? "approval_required" : "allow",
        tools: [...DESTRUCTIVE_TOOL_NAMES],
        priority: 100,
        description:
          "Destructive MediaLocker tools (delete/purge). Defaults to approval_required " +
          "(fail-closed when approval server is disabled). Set enableApprovals=false to allow " +
          "after arg validation + scope checks.",
      },
    ],
  });
}

export interface FirewallOptions {
  /** Require human approval for destructive tools (default true — fail-closed). */
  enableApprovals?: boolean;
}

export class ToolFirewall {
  private readonly engine: PolicyEngine;
  private readonly validator: ArgumentValidator;
  private readonly audit: AuditLogger;

  constructor(options: FirewallOptions = {}) {
    const policy = buildPolicy(options.enableApprovals ?? true);
    this.engine = new PolicyEngine(policy);
    // General argument-safety validator (the package's built-in shell-safe /
    // secret-scan validators apply even with no custom rules). Tool-specific
    // arg constraints (e.g. purge.confirm) are enforced via policy conditions.
    this.validator = new ArgumentValidator([]);
    // The firewall AuditLogger forbids a `stdout` sink (stdout is reserved for
    // the MCP JSON-RPC stream). We run it in `silent` mode — it still performs
    // the package's redaction/leveling — and mirror each decision through
    // @medialocker/observability so it lands in the platform log pipeline.
    this.audit = new AuditLogger({ config: { level: "full" }, silent: true });
  }

  private isDestructive(toolName: string): toolName is DestructiveToolName {
    return (DESTRUCTIVE_TOOL_NAMES as readonly string[]).includes(toolName);
  }

  /**
   * Evaluate a tool call. Throws `ValidationError` / `PolicyViolationError`
   * (subclasses of `FirewallError`) when blocked. Non-destructive tools pass
   * through cheaply (still audited at ALLOW). Always writes an audit event.
   */
  async check(params: {
    toolName: string;
    args: Record<string, unknown>;
    sessionId: string;
    requestId: string;
    orgId: string;
  }): Promise<void> {
    const start = Date.now();
    const ctx = createRequestContext({
      requestId: params.requestId,
      sessionId: params.sessionId,
      method: "tools/call",
      toolName: params.toolName,
      arguments: params.args,
    });

    // Argument validation (e.g. purge.confirm) — runs for all tools; only the
    // configured rules actually match.
    const validation = await this.validator.execute(ctx);
    if (validation.action === "BLOCK") {
      await this.logDecision(params, "BLOCK", start, validation.reason, "argument-validator");
      throw new ValidationError({
        message: validation.reason ?? "Argument validation failed",
        requestId: params.requestId,
        details: { tool: params.toolName },
      });
    }

    // Policy evaluation (BLOCK / APPROVAL_REQUIRED / ALLOW).
    const result = await this.engine.evaluate(ctx);
    if (result.action === "BLOCK") {
      await this.logDecision(params, "BLOCK", start, result.reason, result.rule?.id);
      throw new PolicyViolationError({
        message: result.reason ?? `Tool '${params.toolName}' blocked by policy`,
        requestId: params.requestId,
        details: { tool: params.toolName, rule: result.rule?.id },
      });
    }
    if (result.action === "APPROVAL_REQUIRED") {
      // v1: approvals are disabled by default — fail closed rather than stand up
      // a blocking approval server.
      await this.logDecision(params, "APPROVAL_REQUIRED", start, result.reason, result.rule?.id);
      throw new PolicyViolationError({
        message:
          result.reason ??
          `Tool '${params.toolName}' requires human approval, which is disabled in this deployment`,
        requestId: params.requestId,
        details: { tool: params.toolName, rule: result.rule?.id, approvalsDisabled: true },
      });
    }

    await this.logDecision(params, "ALLOW", start, undefined, result.rule?.id);
    if (this.isDestructive(params.toolName)) {
      logger.warn(
        { tool: params.toolName, orgId: params.orgId },
        "destructive tool permitted by firewall",
      );
    }
  }

  private async logDecision(
    params: { toolName: string; args: Record<string, unknown>; sessionId: string; orgId: string },
    decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED",
    start: number,
    reason?: string,
    blockedBy?: string,
  ): Promise<void> {
    try {
      await this.audit.log({
        type: "tool_call",
        sessionId: params.sessionId,
        toolName: params.toolName,
        arguments: params.args,
        decision,
        ...(blockedBy ? { blockedBy } : {}),
        latency: Date.now() - start,
        metadata: { orgId: params.orgId, ...(reason ? { reason } : {}) },
      });
      // Mirror into the platform log pipeline (the silent AuditLogger above does
      // not emit on its own).
      logger.info(
        {
          event: "firewall.decision",
          tool: params.toolName,
          decision,
          orgId: params.orgId,
          sessionId: params.sessionId,
          ...(blockedBy ? { blockedBy } : {}),
          ...(reason ? { reason } : {}),
        },
        "firewall decision",
      );
    } catch (err) {
      // Audit is best-effort and must never break a tool call.
      logger.error({ err }, "firewall audit log failed");
    }
  }

  close(): void {
    this.audit.close();
  }
}

/** Singleton firewall for the process. */
let _firewall: ToolFirewall | null = null;
export function getFirewall(): ToolFirewall {
  if (!_firewall) _firewall = new ToolFirewall();
  return _firewall;
}
