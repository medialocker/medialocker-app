import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { handleWebhook } from "@medialocker/billing";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post(
    "/stripe/webhook",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers["stripe-signature"] as string | undefined;
      if (!signature) {
        return reply.status(400).send({ error: { code: "BadRequest", message: "Missing stripe-signature header" } });
      }

      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body as any);
      try {
        const result = await handleWebhook(rawBody, signature, { client: request.sql });
        if (!result.received) {
          return reply.status(400).send({ error: { code: "BadRequest", message: result.error ?? "Webhook rejected" } });
        }
        return reply.status(200).send({ received: true, eventId: result.eventId });
      } catch (err) {
        request.log?.error?.({ err }, "Stripe webhook handler failed");
        // 500 → Stripe retries; billing already rolled back its webhook_events row.
        return reply.status(500).send({ error: { code: "InternalError", message: "Webhook handler failed" } });
      }
    },
  );
}
