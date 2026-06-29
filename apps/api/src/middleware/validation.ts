import { FastifyRequest, FastifyReply } from "fastify";
import { ZodSchema, ZodError } from "zod";
import { createLogger } from "@medialocker/observability";

const logger = createLogger("api:validation");

const registeredSchemas = new WeakMap<object, { body?: ZodSchema; query?: ZodSchema; params?: ZodSchema }>();

export function registerSchema(
  route: object,
  schemas: { body?: ZodSchema; query?: ZodSchema; params?: ZodSchema },
): void {
  registeredSchemas.set(route, schemas);
}

export function getRegisteredSchema(route: object) {
  return registeredSchemas.get(route);
}

export async function validationHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Hook is registered early; schemas are attached per-route via preHandler
}

export function validate(schemas: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (schemas.body) {
        request.body = schemas.body.parse(request.body);
      }
      if (schemas.query) {
        const parsed = schemas.query.parse(request.query);
        (request as any).validatedQuery = parsed;
      }
      if (schemas.params) {
        const parsed = schemas.params.parse(request.params);
        (request as any).validatedParams = parsed;
      }
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({
          error: {
            code: "ValidationError",
            message: "Request validation failed",
            details: err.errors.map((e) => ({
              path: e.path.join("."),
              message: e.message,
            })),
          },
        });
        return;
      }
      throw err;
    }
  };
}
