import { FastifyInstance } from "fastify";
import { validate } from "./middleware/validation.js";

function buildOpenApiSpec(): object {
  return {
    openapi: "3.0.3",
    info: {
      title: "MediaLocker API",
      description: "REST/JSON control plane for MediaLocker.io — manage buckets, media, tags, sets, storyboards, billing, and more.",
      version: "0.0.0",
    },
    servers: [
      { url: `${process.env.PUBLIC_BASE_DOMAIN ? `https://api.${process.env.PUBLIC_BASE_DOMAIN}` : "https://api.medialocker.io"}/api`, description: "Production" },
    ],
    paths: {
      "/me": {
        get: {
          summary: "Get current user info",
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "User info with organization memberships" } },
        },
      },
      "/api-keys": {
        get: {
          summary: "List API keys",
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "List of API keys for the organization" } },
        },
        post: {
          summary: "Create API key",
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string", enum: ["read", "write", "delete", "admin"] } }, bucketId: { type: "string" }, expiresInDays: { type: "integer", default: 90 } }, required: ["name"] } } },
          },
          responses: { "201": { description: "API key created — secret shown once" } },
        },
      },
      "/api-keys/{id}": {
        delete: {
          summary: "Revoke API key",
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "API key revoked" } },
        },
      },
      "/api-keys/{id}/rotate": {
        put: {
          summary: "Rotate API key",
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "New secret returned" } },
        },
      },
      "/buckets": {
        get: {
          summary: "List buckets",
          tags: ["Buckets"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Organization buckets with usage summaries" } },
        },
        post: {
          summary: "Create bucket",
          tags: ["Buckets"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
          },
          responses: { "201": { description: "Bucket created" } },
        },
      },
      "/buckets/{id}": {
        get: {
          summary: "Get bucket details",
          tags: ["Buckets"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Bucket details with usage" } },
        },
        delete: {
          summary: "Delete bucket",
          tags: ["Buckets"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Bucket deleted" }, "409": { description: "Bucket not empty" } },
        },
      },
      "/media": {
        get: {
          summary: "List media objects",
          tags: ["Media"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "bucketId", in: "query", schema: { type: "string" } },
            { name: "kind", in: "query", schema: { type: "string", enum: ["image", "video", "audio", "pdf", "3d", "other"] } },
            { name: "sort", in: "query", schema: { type: "string", enum: ["created_at", "size", "key"], default: "created_at" } },
            { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "search", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Paginated media listing" } },
        },
      },
      "/media/{id}": {
        get: {
          summary: "Get media detail",
          tags: ["Media"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Media asset detail" } },
        },
        delete: {
          summary: "Soft-delete media",
          tags: ["Media"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Media soft-deleted" } },
        },
      },
      "/media/{id}/thumbnail": {
        get: {
          summary: "Get media thumbnail/poster derivative",
          description: "Streams the object's thumbnail (or video poster) from the private derived bucket, served with the derivative's stored content type.",
          tags: ["Media"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Image bytes" }, "404": { description: "No thumbnail available" } },
        },
      },
      "/media/{id}/stream": {
        get: {
          summary: "Redirect to a presigned object stream URL",
          tags: ["Media"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "302": { description: "Redirect to a presigned GET URL" }, "404": { description: "Media not found" } },
        },
      },
      "/media/{id}/metadata": {
        put: {
          summary: "Update media metadata",
          tags: ["Media"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { metadata: { type: "object", additionalProperties: { type: "string" } } }, required: ["metadata"] } } },
          },
          responses: { "200": { description: "Metadata updated" } },
        },
      },
      "/tags": {
        get: {
          summary: "List tags",
          tags: ["Tags"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "search", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "List of tags" } },
        },
        post: {
          summary: "Create tag",
          tags: ["Tags"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
          },
          responses: { "201": { description: "Tag created" } },
        },
      },
      "/tags/{id}": {
        delete: {
          summary: "Delete tag",
          tags: ["Tags"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Tag deleted" } },
        },
      },
      "/objects/{id}/tags": {
        put: {
          summary: "Set tags on object",
          tags: ["Tags"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { tagIds: { type: "array", items: { type: "string" } } }, required: ["tagIds"] } } },
          },
          responses: { "200": { description: "Tags updated on object" } },
        },
      },
      "/categories": {
        get: {
          summary: "List categories (tree)",
          tags: ["Categories"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Hierarchical category tree" } },
        },
        post: {
          summary: "Create category",
          tags: ["Categories"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, parentId: { type: "string" } }, required: ["name"] } } },
          },
          responses: { "201": { description: "Category created" } },
        },
      },
      "/categories/{id}": {
        delete: {
          summary: "Delete category",
          tags: ["Categories"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Category deleted, children reassigned to root, object assignments removed" } },
        },
      },
      "/objects/{id}/categories": {
        put: {
          summary: "Set categories on object",
          tags: ["Categories"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { categoryIds: { type: "array", items: { type: "string" } } }, required: ["categoryIds"] } } },
          },
          responses: { "200": { description: "Categories set on object" } },
        },
      },
      "/sets": {
        get: {
          summary: "List sets",
          tags: ["Sets"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "List of sets" } },
        },
        post: {
          summary: "Create set",
          tags: ["Sets"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, baseObjectId: { type: "string" } }, required: ["name"] } } },
          },
          responses: { "201": { description: "Set created" } },
        },
      },
      "/sets/{id}": {
        get: {
          summary: "Get set detail",
          tags: ["Sets"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Set with items" } },
        },
        delete: {
          summary: "Delete set",
          tags: ["Sets"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Set deleted" } },
        },
      },
      "/sets/{id}/items": {
        post: {
          summary: "Add item to set",
          tags: ["Sets"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { objectId: { type: "string" }, aspectRatio: { type: "string" }, width: { type: "integer" }, height: { type: "integer" }, role: { type: "string" } }, required: ["objectId"] } } },
          },
          responses: { "201": { description: "Item added" } },
        },
      },
      "/sets/{id}/items/{itemId}": {
        delete: {
          summary: "Remove item from set",
          tags: ["Sets"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "itemId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Item removed" } },
        },
      },
      "/sets/{id}/generate": {
        post: {
          summary: "Trigger variant generation",
          tags: ["Sets"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "202": { description: "Generation enqueued" } },
        },
      },
      "/storyboards": {
        get: {
          summary: "List storyboards",
          tags: ["Storyboards"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "List of storyboards" } },
        },
        post: {
          summary: "Create storyboard",
          tags: ["Storyboards"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
          },
          responses: { "201": { description: "Storyboard created" } },
        },
      },
      "/storyboards/{id}": {
        get: {
          summary: "Get storyboard detail",
          tags: ["Storyboards"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Storyboard with clips" } },
        },
        delete: {
          summary: "Delete storyboard",
          tags: ["Storyboards"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Storyboard deleted" } },
        },
      },
      "/storyboards/{id}/clips": {
        post: {
          summary: "Add clip to storyboard",
          tags: ["Storyboards"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { objectId: { type: "string" }, position: { type: "integer" }, note: { type: "string" } }, required: ["objectId"] } } },
          },
          responses: { "201": { description: "Clip added" } },
        },
      },
      "/storyboards/{id}/clips/reorder": {
        put: {
          summary: "Reorder storyboard clips",
          tags: ["Storyboards"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { clipIds: { type: "array", items: { type: "string" } } }, required: ["clipIds"] } } },
          },
          responses: { "200": { description: "Clips reordered" }, "400": { description: "clipIds must all belong to this storyboard" } },
        },
      },
      "/storyboards/{id}/clips/{clipId}": {
        put: {
          summary: "Update clip",
          tags: ["Storyboards"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "clipId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { position: { type: "integer" }, note: { type: "string" } } } } },
          },
          responses: { "200": { description: "Clip updated" } },
        },
        delete: {
          summary: "Remove clip",
          tags: ["Storyboards"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "clipId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Clip removed" } },
        },
      },
      "/search": {
        get: {
          summary: "Full-text search",
          tags: ["Search"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "kind", in: "query", schema: { type: "string" } },
            { name: "tags", in: "query", schema: { type: "string" } },
            { name: "categories", in: "query", schema: { type: "string" } },
            { name: "bucketId", in: "query", schema: { type: "string" } },
            { name: "sizeMin", in: "query", schema: { type: "integer" } },
            { name: "sizeMax", in: "query", schema: { type: "integer" } },
            { name: "dateFrom", in: "query", schema: { type: "string" } },
            { name: "dateTo", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { "200": { description: "Search results with facets" } },
        },
      },
      "/usage": {
        get: {
          summary: "Current usage stats",
          tags: ["Usage"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Storage used, allocated, free, egress, requests" } },
        },
      },
      "/usage/history": {
        get: {
          summary: "Usage history",
          tags: ["Usage"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "days", in: "query", schema: { type: "integer", default: 30 } }],
          responses: { "200": { description: "Usage rollup history" } },
        },
      },
      "/usage/events": {
        get: {
          summary: "Usage events ledger",
          tags: ["Usage"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "days", in: "query", schema: { type: "integer", default: 30 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { "200": { description: "Raw usage events (stored deltas, egress, requests)" } },
        },
      },
      "/billing/subscription": {
        get: {
          summary: "Current subscription",
          tags: ["Billing"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Current plan, add-ons, next bill" } },
        },
      },
      "/billing/capacity/add": {
        post: {
          summary: "Add capacity",
          tags: ["Billing"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { gb: { type: "integer" } }, required: ["gb"] } } },
          },
          responses: { "200": { description: "Capacity added" } },
        },
      },
      "/billing/capacity/auto": {
        put: {
          summary: "Configure auto-capacity",
          tags: ["Billing"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { enabled: { type: "boolean" }, incrementGb: { type: "integer" }, thresholdPct: { type: "number" }, maxMonthlySpendCents: { type: "integer" } }, required: ["enabled"] } } },
          },
          responses: { "200": { description: "Auto-capacity configured" } },
        },
      },
      "/billing/downgrade": {
        post: {
          summary: "Change plan / downgrade",
          tags: ["Billing"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { tierKey: { type: "string" } }, required: ["tierKey"] } } },
          },
          responses: { "200": { description: "Plan changed" }, "409": { description: "Downgrade blocked — usage exceeds target plan" } },
        },
      },
      "/billing/invoices": {
        get: {
          summary: "List Stripe invoices",
          tags: ["Billing"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Recent invoices" }, "501": { description: "Stripe not configured" } },
        },
      },
      "/billing/portal": {
        get: {
          summary: "Stripe Customer Portal URL",
          tags: ["Billing"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Portal URL" } },
        },
      },
      "/presign/upload": {
        post: {
          summary: "Generate presigned upload URL",
          tags: ["Presign"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { bucketId: { type: "string" }, key: { type: "string" }, contentType: { type: "string" }, size: { type: "integer" } }, required: ["bucketId", "key"] } } },
          },
          responses: { "200": { description: "Presigned PUT URL" } },
        },
      },
      "/presign/create-multipart": {
        post: {
          summary: "Initiate a presigned multipart upload",
          tags: ["Presign"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { bucketId: { type: "string" }, key: { type: "string" }, contentType: { type: "string" } }, required: ["bucketId", "key"] } } },
          },
          responses: { "200": { description: "Presigned POST URL for InitiateMultipartUpload" } },
        },
      },
      "/presign/upload-part": {
        post: {
          summary: "Generate presigned multipart part URL",
          tags: ["Presign"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Part upload URL" } },
        },
      },
      "/presign/complete-upload": {
        post: {
          summary: "Complete multipart upload",
          tags: ["Presign"],
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Upload completed" } },
        },
      },
      "/presign/confirm": {
        post: {
          summary: "Confirm a direct upload (authoritative size + quota true-up)",
          tags: ["Presign"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { bucketId: { type: "string" }, key: { type: "string" } }, required: ["bucketId", "key"] } } },
          },
          responses: { "200": { description: "Object recorded; derivatives enqueued" } },
        },
      },
      "/presign/download": {
        post: {
          summary: "Generate presigned download URL",
          tags: ["Presign"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { objectId: { type: "string" }, expiresIn: { type: "integer", default: 3600 } }, required: ["objectId"] } } },
          },
          responses: { "200": { description: "Presigned GET URL" } },
        },
      },
      "/stripe/webhook": {
        post: {
          summary: "Stripe webhook receiver",
          tags: ["Webhook"],
          responses: { "200": { description: "Webhook processed" } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT or API Key" },
      },
    },
  };
}

export async function openapiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/openapi.json", { preHandler: [validate({})] }, async (_request, reply) => {
    return reply.send(buildOpenApiSpec());
  });
}

export { buildOpenApiSpec };
