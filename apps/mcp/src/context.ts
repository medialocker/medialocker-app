/**
 * Per-request context carrier.
 *
 * The preHandler in apps/mcp/src/index.ts stores the request context on the
 * raw Node.js IncomingMessage as `.auth`. The transport picks it up and threads
 * it through `authInfo` → `extra.authInfo` to the MCP SDK handlers. In
 * server.ts, the `CallToolRequestSchema` handler wraps the tool dispatch in
 * `requestScope.run(scope, ...)`, establishing the AsyncLocalStorage store for
 * the duration of the tool call so that `getRequestScope()` works correctly
 * inside every tool handler.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
import type { EnvConfig } from "@medialocker/config";
import type { MediaLockerAuth } from "./auth.js";

export interface RequestScope {
  sql: ReturnType<typeof postgres>;
  config: EnvConfig;
  auth: MediaLockerAuth;
  requestId: string;
  sessionId: string;
}

export const requestScope = new AsyncLocalStorage<RequestScope>();

export function getRequestScope(): RequestScope {
  const scope = requestScope.getStore();
  if (!scope) {
    throw new Error("No request scope: tool invoked outside an authenticated MCP request");
  }
  return scope;
}
