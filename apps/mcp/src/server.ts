/**
 * MediaLocker MCP server factory.
 *
 * Bridges the MediaLocker tool registry into an `@modelcontextprotocol/sdk`
 * `McpServer` so the `@reaatech/mcp-server-transport` Streamable-HTTP transport
 * (whose `serverFactory` returns an `McpServer`) can drive it.
 *
 * Tool registration is migrated to `@reaatech/mcp-server-tools`: each MediaLocker
 * tool is registered via that package's `registerTool()` (the mandated registry),
 * and we drive `tools/list` + `tools/call` from `getTools()`. The original tool
 * `name`, JSON-Schema `inputSchema`, and handler logic are preserved verbatim —
 * we only adapt the registration shape and inject `{ sql, auth, config }` via the
 * request-scoped `AsyncLocalStorage` (`./context`).
 *
 * Destructive tools (`delete_object`/`delete_bucket`/`purge`) are gated through
 * the `@reaatech/tool-use-firewall-*` stack (`./firewall`) before their handler
 * runs, on top of the per-tenant allowlist (gateway) and per-handler scope
 * checks (defense in depth).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  registerTool as registerFrameworkTool,
  getTools as getFrameworkTools,
  getTool as getFrameworkTool,
  clearTools as clearFrameworkTools,
  type ToolDefinition as FrameworkToolDefinition,
} from "@reaatech/mcp-server-tools";
import { SERVER_INFO, textContent } from "@reaatech/mcp-server-core";
import { logToolExecution, recordToolInvocation } from "@reaatech/mcp-server-observability";
import { createLogger } from "@medialocker/observability";
import { getRequestScope, requestScope } from "./context.js";
import { getFirewall, DESTRUCTIVE_TOOL_NAMES } from "./firewall.js";
import { registerAllTools, type MediaLockerTool } from "./tools/index.js";

const logger = createLogger("mcp:server");

/**
 * JSON-Schema input shape carried by every MediaLocker tool (unchanged from the
 * original hand-rolled server).
 */
export interface JsonSchemaInput {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/** Source-of-truth metadata for `tools/list`, kept alongside the framework registry. */
interface ToolMeta {
  name: string;
  description: string;
  inputSchema: JsonSchemaInput;
}

const toolMeta = new Map<string, ToolMeta>();

function isDestructive(name: string): boolean {
  return (DESTRUCTIVE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Register the full MediaLocker tool catalogue into the `@reaatech/mcp-server-tools`
 * registry. Idempotent: clears first so repeated calls (tests, hot reload) are safe.
 */
export function registerMediaLockerTools(): ToolMeta[] {
  clearFrameworkTools();
  toolMeta.clear();

  registerAllTools((tool: MediaLockerTool) => {
    toolMeta.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });

    const fram3workTool: FrameworkToolDefinition = {
      name: tool.name,
      description: tool.description,
      // The framework's ToolDefinition requires a Zod object; the authoritative
      // JSON-Schema lives in `toolMeta`/`tools/list`. We accept and forward the
      // raw arguments untouched so the original handler logic is preserved.
      // (apps/mcp pins zod v3 while the framework's types reference zod v4; the
      // shapes are runtime-compatible, so we bridge the two with a cast.)
      inputSchema: z.object({}).passthrough() as unknown as FrameworkToolDefinition["inputSchema"],
      handler: async (args: Record<string, unknown>) => {
        const scope = getRequestScope();

        // Firewall gate for destructive tools (policy + arg validation + audit).
        if (isDestructive(tool.name)) {
          await getFirewall().check({
            toolName: tool.name,
            args,
            sessionId: scope.sessionId,
            requestId: scope.requestId,
            orgId: scope.auth.orgId,
          });
        }

        const result = await tool.handler(args, {
          sql: scope.sql,
          auth: scope.auth,
          config: scope.config,
        });

        // Framework ToolResponse: stringify structured result as a text block.
        const text =
          typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 2);
        return { content: [textContent(text)] };
      },
    };
    registerFrameworkTool(fram3workTool);
  });

  return [...toolMeta.values()];
}

/**
 * Build a fresh `McpServer` wired to the registered tool catalogue.
 * Used as the transport `serverFactory` (one instance per session).
 */
export function createMediaLockerMcpServer(): McpServer {
  if (toolMeta.size === 0) {
    registerMediaLockerTools();
  }

  const mcp = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });

  // tools/list — authoritative JSON-Schema from the MediaLocker registry.
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...toolMeta.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // tools/call — dispatch through the framework registry (firewall + injection).
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const scope = (extra as any)?.authInfo as import("./context.js").RequestScope | undefined;
    if (!scope) {
      return {
        content: [textContent("No request context available — authentication may be missing.")],
        isError: true,
      };
    }
    return requestScope.run(scope, async () => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const tool = getFrameworkTool(name);

      if (!tool) {
        recordToolInvocation({ toolName: name, status: "error", durationMs: 0 });
        return {
          content: [textContent(`Tool not found: ${name}`)],
          isError: true,
        };
      }

      const start = Date.now();
      try {
        const response = await tool.handler(args, {
          request: { requestId: scope.requestId, sessionId: scope.sessionId },
        });
        const durationMs = Date.now() - start;
        recordToolInvocation({ toolName: name, status: "success", durationMs });
        logToolExecution({
          toolName: name,
          action: "tools/call",
          durationMs,
          success: true,
          context: { requestId: scope.requestId, sessionId: scope.sessionId },
        });
        return response;
      } catch (err) {
        const durationMs = Date.now() - start;

        // Structured validation error at the tool boundary (P2.24): a ZodError
        // means the caller sent invalid params. Surface a structured,
        // client-actionable error instead of masking it as "Internal error".
        if (err instanceof z.ZodError) {
          const issues = err.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
            code: i.code,
          }));
          logger.warn(
            { tool: name, requestId: scope.requestId, sessionId: scope.sessionId, issues },
            "tool params failed validation",
          );
          recordToolInvocation({ toolName: name, status: "error", durationMs });
          logToolExecution({
            toolName: name,
            action: "tools/call",
            durationMs,
            success: false,
            error: "Invalid params",
            context: { requestId: scope.requestId, sessionId: scope.sessionId },
          });
          return {
            content: [
              textContent(
                JSON.stringify(
                  { error: "ValidationError", message: `Invalid params for ${name}`, issues },
                  null,
                  2,
                ),
              ),
            ],
            isError: true,
          };
        }

        logger.error({ err, tool: name, requestId: scope.requestId, sessionId: scope.sessionId }, "tool execution failed");
        recordToolInvocation({ toolName: name, status: "error", durationMs });
        logToolExecution({
          toolName: name,
          action: "tools/call",
          durationMs,
          success: false,
          error: "Internal error",
          context: { requestId: scope.requestId, sessionId: scope.sessionId },
        });
        return { content: [textContent("Internal error")], isError: true };
      }
    });
  });

  return mcp;
}

/** Expose the framework tool list (used by health/diagnostics + tests). */
export function listRegisteredTools(): string[] {
  return getFrameworkTools().map((t) => t.name);
}
