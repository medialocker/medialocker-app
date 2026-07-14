import { FastifyInstance } from "fastify";
import { z } from "zod";
import { validate } from "../middleware/validation.js";
import { sendContactNotification, sendContactAck } from "@medialocker/email";
import { createLogger } from "@medialocker/observability";

const log = createLogger("api:contact");

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  // Optional on the form; defaulted server-side so the email always has a subject.
  subject: z.string().trim().max(200).optional(),
  message: z.string().trim().min(1).max(5000),
  // Honeypot: a hidden field real users leave empty. Present in the schema so a
  // filled value doesn't 400 — we accept it, then silently drop (see handler).
  company: z.string().max(200).optional(),
});

/**
 * Public website contact form. Unauthenticated (listed in the api's openPaths)
 * and cross-origin from the marketing site, so it is defended by: a strict
 * per-route rate limit (below), a honeypot, and length-bounded zod validation.
 * The Resend key lives server-side here; the browser only ever POSTs JSON.
 */
export async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/contact",
    {
      // Tighter than the global 300/min limiter: a contact form should never be
      // hit more than a handful of times per IP. Keyed by the global keyGenerator
      // (falls back to request.ip for unauthenticated calls).
      config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
      preHandler: [validate({ body: contactSchema })],
    },
    async (request, reply) => {
      const cfg = request.config;
      const body = request.body as z.infer<typeof contactSchema>;

      // Honeypot tripped → look successful to the bot, send nothing.
      if (body.company && body.company.trim().length > 0) {
        log.warn({ ip: request.ip }, "Contact honeypot tripped — dropping submission");
        return reply.status(200).send({ ok: true });
      }

      const res = await sendContactNotification(cfg.CONTACT_INBOX, {
        name: body.name,
        email: body.email,
        subject: body.subject?.trim() || "New contact-form message",
        message: body.message,
      });

      // `skipped` = email disabled (no RESEND_API_KEY): accept in dev rather than
      // 502. A real send failure (res.error) surfaces so the form shows an error.
      if (!res.sent && !res.skipped) {
        log.error({ error: res.error }, "Contact notification failed to send");
        return reply.status(502).send({
          error: {
            code: "EmailSendFailed",
            message:
              "Sorry — we couldn't send your message. Please try again, or email us directly.",
          },
        });
      }
      if (res.skipped) {
        log.warn({ inbox: cfg.CONTACT_INBOX }, "Contact email skipped (RESEND_API_KEY unset)");
      }

      // Best-effort acknowledgement to the submitter — never fails the request.
      void sendContactAck(body.email, { name: body.name, email: body.email });

      return reply.status(200).send({ ok: true });
    },
  );
}
