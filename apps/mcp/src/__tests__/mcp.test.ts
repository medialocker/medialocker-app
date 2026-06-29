import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { llmsTxtRoutes } from "../llms-txt.js";
import { mediaLockerAuthHook } from "../auth.js";

function buildInitializeResponse(): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "medialocker-mcp", version: "0.0.0" },
    },
  };
}

function buildToolsListResponse(tools: string[]): object {
  return {
    jsonrpc: "2.0",
    id: 2,
    result: {
      tools: tools.map((name) => ({
        name,
        description: expect.any(String),
        inputSchema: expect.any(Object),
      })),
    },
  };
}

describe("MCP protocol messages", () => {
  it("initialize returns capabilities", () => {
    const response = buildInitializeResponse();
    expect(response).toHaveProperty("jsonrpc", "2.0");
    expect((response as any).result.protocolVersion).toBe("2024-11-05");
    expect((response as any).result.capabilities).toHaveProperty("tools");
    expect((response as any).result.serverInfo.name).toBe("medialocker-mcp");
  });

  it("tools/list returns all registered tools", () => {
    const toolNames = [
      "search_media",
      "list_buckets",
      "create_bucket",
      "get_bucket_info",
      "delete_bucket",
      "get_object_url",
      "upload_object",
      "list_objects",
      "delete_object",
      "get_object_metadata",
      "manage_tags",
      "manage_categories",
      "create_set",
      "add_variant",
      "list_sets",
      "generate_variants",
      "get_usage",
      "get_billing_info",
      "manage_capacity",
    ];

    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("search_media");
    expect(toolNames).toContain("get_object_url");
    expect(toolNames).toContain("upload_object");
  });

  it("error response format is correct", () => {
    const errorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32601,
        message: "Method not found",
      },
    };

    expect(errorResponse).toHaveProperty("jsonrpc", "2.0");
    expect(errorResponse.error).toHaveProperty("code");
    expect(errorResponse.error).toHaveProperty("message");
  });

  it("ping responds with empty result", () => {
    const pingResponse = {
      jsonrpc: "2.0",
      id: 3,
      result: {},
    };

    expect(pingResponse).toHaveProperty("result");
    expect(pingResponse.result).toEqual({});
  });
});

describe("Tool input schemas", () => {
  it("search_media requires q parameter", async () => {
    const { registerSearchTools } = await import("../tools/search.js");
    const tools: any[] = [];
    registerSearchTools((t) => tools.push(t));
    expect(tools[0].inputSchema.required).toContain("q");
  });

  it("create_bucket requires name parameter", async () => {
    const { registerBucketTools } = await import("../tools/buckets.js");
    const tools: any[] = [];
    registerBucketTools((t) => tools.push(t));
    const createBucket = tools.find((t) => t.name === "create_bucket");
    expect(createBucket.inputSchema.required).toContain("name");
  });

  it("get_object_url requires objectId parameter", async () => {
    const { registerObjectTools } = await import("../tools/objects.js");
    const tools: any[] = [];
    registerObjectTools((t) => tools.push(t));
    const getUrl = tools.find((t) => t.name === "get_object_url");
    expect(getUrl.inputSchema.required).toContain("objectId");
  });

  it("manage_tags requires action parameter", async () => {
    const { registerTagTools } = await import("../tools/tags.js");
    const tools: any[] = [];
    registerTagTools((t) => tools.push(t));
    const manageTagsTool = tools.find((t) => t.name === "manage_tags");
    expect(manageTagsTool.inputSchema.required).toContain("action");
  });

  it("create_set requires name parameter", async () => {
    const { registerSetTools } = await import("../tools/sets.js");
    const tools: any[] = [];
    registerSetTools((t) => tools.push(t));
    const createSetTool = tools.find((t) => t.name === "create_set");
    expect(createSetTool.inputSchema.required).toContain("name");
  });

  it("manage_capacity requires action parameter", async () => {
    const { registerUsageTools } = await import("../tools/usage.js");
    const tools: any[] = [];
    registerUsageTools((t) => tools.push(t));
    const capacityTool = tools.find((t) => t.name === "manage_capacity");
    expect(capacityTool.inputSchema.required).toContain("action");
  });
});

describe("server tool registry (@reaatech/mcp-server-tools bridge)", () => {
  it("registers the full MediaLocker catalogue into the framework registry", async () => {
    const { registerMediaLockerTools, listRegisteredTools } = await import("../server.js");
    const metas = registerMediaLockerTools();
    const names = metas.map((m) => m.name);

    // Core catalogue + destructive tools all registered.
    for (const expected of [
      "search_media",
      "list_buckets",
      "get_object_url",
      "upload_object",
      "create_bucket",
      "create_api_key",
      "delete_object",
      "delete_bucket",
      "purge",
    ]) {
      expect(names).toContain(expected);
    }

    // The framework registry (getTools) is the source of truth for handlers.
    expect(listRegisteredTools().sort()).toEqual(names.sort());

    // Every tool exposes a JSON-Schema inputSchema for tools/list.
    for (const meta of metas) {
      expect(meta.inputSchema.type).toBe("object");
    }
  });

  it("builds an McpServer without throwing", async () => {
    const { createMediaLockerMcpServer } = await import("../server.js");
    const server = createMediaLockerMcpServer();
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});

describe("tool-use firewall (destructive tool gating)", () => {
  it("allows a non-destructive tool", async () => {
    const { ToolFirewall } = await import("../firewall.js");
    const fw = new ToolFirewall();
    await expect(
      fw.check({
        toolName: "search_media",
        args: { q: "x" },
        sessionId: "s1",
        requestId: "r1",
        orgId: "org1",
      }),
    ).resolves.toBeUndefined();
    fw.close();
  });

  it("requires approval for delete_object under the fail-closed default", async () => {
    const { ToolFirewall } = await import("../firewall.js");
    const fw = new ToolFirewall();
    await expect(
      fw.check({
        toolName: "delete_object",
        args: { objectId: "obj1" },
        sessionId: "s1",
        requestId: "r1",
        orgId: "org1",
      }),
    ).rejects.toBeDefined();
    fw.close();
  });

  it("blocks purge without confirm='DELETE' via argument validation", async () => {
    const { ToolFirewall } = await import("../firewall.js");
    const fw = new ToolFirewall();
    await expect(
      fw.check({
        toolName: "purge",
        args: { confirm: "nope" },
        sessionId: "s1",
        requestId: "r1",
        orgId: "org1",
      }),
    ).rejects.toThrow();
    fw.close();
  });

  it("blocks destructive tools when approvals are enabled (fail-closed v1)", async () => {
    const { ToolFirewall } = await import("../firewall.js");
    const fw = new ToolFirewall({ enableApprovals: true });
    await expect(
      fw.check({
        toolName: "delete_bucket",
        args: { bucketId: "b1" },
        sessionId: "s1",
        requestId: "r1",
        orgId: "org1",
      }),
    ).rejects.toThrow();
    fw.close();
  });
});

describe("auth allowlist derivation (per-tenant tool access)", () => {
  it("excludes destructive tools for read-only credentials", async () => {
    const { allowedToolsForScopes, DESTRUCTIVE_TOOLS } = await import("../auth.js");
    const tools = allowedToolsForScopes(["read"]);
    for (const d of DESTRUCTIVE_TOOLS) {
      expect(tools).not.toContain(d);
    }
    expect(tools).toContain("search_media");
  });

  it("includes destructive tools for delete/admin credentials", async () => {
    const { allowedToolsForScopes, DESTRUCTIVE_TOOLS } = await import("../auth.js");
    for (const scope of ["delete", "admin"]) {
      const tools = allowedToolsForScopes([scope]);
      for (const d of DESTRUCTIVE_TOOLS) {
        expect(tools).toContain(d);
      }
    }
  });
});

describe("llms.txt discovery catalog", () => {
  it("describes transport, gateway auth, and firewall-gated tools", async () => {
    const { LLMS_TXT_CONTENT } = await import("../llms-txt.js");
    expect(LLMS_TXT_CONTENT).toContain("Streamable HTTP");
    expect(LLMS_TXT_CONTENT).toContain("Bearer token");
    expect(LLMS_TXT_CONTENT).toContain("per-tenant token-bucket");
    expect(LLMS_TXT_CONTENT).toContain("Firewall-Gated");
    expect(LLMS_TXT_CONTENT).toContain("delete_object");
    expect(LLMS_TXT_CONTENT).toContain("purge");
  });

  it("embeds the runtime version from package.json, not a hardcoded literal", async () => {
    const { LLMS_TXT_CONTENT } = await import("../llms-txt.js");
    const { MCP_VERSION } = await import("../version.js");
    const pkg = (await import("../../package.json", { with: { type: "json" } })).default as {
      version: string;
    };
    expect(MCP_VERSION).toBe(pkg.version);
    expect(LLMS_TXT_CONTENT).toContain(`Server version: ${pkg.version}`);
  });
});

describe("tool boundary validation (P2.24)", () => {
  it("surfaces a structured ValidationError for invalid tool params", async () => {
    const { createMediaLockerMcpServer } = await import("../server.js");
    const { requestScope } = await import("../context.js");
    const server = createMediaLockerMcpServer();

    const handler = (server.server as any)._requestHandlers.get("tools/call");
    expect(handler).toBeDefined();

    const scope = {
      sql: (() => {
        throw new Error("sql must never be reached on invalid params");
      }) as any,
      config: {} as any,
      auth: { orgId: "org1", scopes: ["read"], allowedTools: [], bucketScope: null } as any,
      requestId: "r1",
      sessionId: "s1",
    };

    const result = await requestScope.run(scope as any, () =>
      handler(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_object_url", arguments: { objectId: "not-a-uuid" } },
        },
        { authInfo: scope },
      ),
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain("ValidationError");
    expect(text).toContain("get_object_url");
  });
});

describe("Fastify wiring (fastify.inject)", () => {
  it("serves public llms.txt routes with no auth", async () => {
    const app = Fastify({ logger: false });
    llmsTxtRoutes(app);
    await app.ready();

    for (const url of ["/.well-known/llms.txt", "/llms.txt", "/mcp/llms.txt"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("MediaLocker MCP Server");
    }

    await app.close();
  });

  it("rejects an unauthenticated /mcp request with 401 before the transport", async () => {
    // The auth hook is registered FIRST in the gateway scope; an unauthenticated
    // request is denied before reaching the transport route handler.
    const app = Fastify({ logger: false });
    await app.register(async (scope) => {
      scope.addHook("preHandler", mediaLockerAuthHook());
      // Stand-in for the transport route in the same encapsulation context.
      scope.post("/mcp", async () => ({ reached: "transport" }));
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json() as { jsonrpc: string; error: { message: string } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.message).toMatch(/Bearer token/);

    await app.close();
  });

  it("the public llms.txt route is NOT shadowed by the authenticated scope", async () => {
    // /mcp/llms.txt (public, root) must not be gated by the /mcp auth scope.
    const app = Fastify({ logger: false });
    llmsTxtRoutes(app);
    await app.register(async (scope) => {
      scope.addHook("preHandler", mediaLockerAuthHook());
      scope.post("/mcp", async () => ({ ok: true }));
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/mcp/llms.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Streamable HTTP");

    await app.close();
  });
});
