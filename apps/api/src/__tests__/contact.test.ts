import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

// Mock the email package: assert the route calls it, without rendering/Resend.
const email = vi.hoisted(() => ({
  sendContactNotification: vi.fn(),
  sendContactAck: vi.fn(),
}));
vi.mock("@medialocker/email", () => email);

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.decorateRequest("config", {
    getter: () => ({ CONTACT_INBOX: "support@medialocker.io" }),
  } as any);

  const { contactRoutes } = await import("../routes/contact.js");
  await app.register(contactRoutes, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  email.sendContactNotification.mockResolvedValue({ sent: true, id: "e1" });
  email.sendContactAck.mockResolvedValue({ sent: true });
});

const valid = {
  name: "Jane Creator",
  email: "jane@example.com",
  subject: "Question about egress",
  message: "Is egress really free?",
};

describe("POST /api/contact", () => {
  it("sends the notification to the support inbox with reply-to the submitter", async () => {
    const res = await app.inject({ method: "POST", url: "/api/contact", payload: valid });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(email.sendContactNotification).toHaveBeenCalledWith(
      "support@medialocker.io",
      expect.objectContaining({ name: "Jane Creator", email: "jane@example.com" }),
    );
    // acknowledgement goes to the submitter
    expect(email.sendContactAck).toHaveBeenCalledWith(
      "jane@example.com",
      expect.objectContaining({ email: "jane@example.com" }),
    );
  });

  it("silently accepts and drops a honeypot-tripped submission", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contact",
      payload: { ...valid, company: "AcmeBot Inc" },
    });
    expect(res.statusCode).toBe(200);
    expect(email.sendContactNotification).not.toHaveBeenCalled();
  });

  it("rejects an invalid email with 400 and sends nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contact",
      payload: { ...valid, email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
    expect(email.sendContactNotification).not.toHaveBeenCalled();
  });

  it("rejects an over-long message with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contact",
      payload: { ...valid, message: "x".repeat(5001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 502 when the send genuinely fails", async () => {
    email.sendContactNotification.mockResolvedValue({ sent: false, error: "domain not verified" });
    const res = await app.inject({ method: "POST", url: "/api/contact", payload: valid });
    expect(res.statusCode).toBe(502);
  });

  it("still accepts (200) when email is disabled (skipped)", async () => {
    email.sendContactNotification.mockResolvedValue({ sent: false, skipped: true });
    const res = await app.inject({ method: "POST", url: "/api/contact", payload: valid });
    expect(res.statusCode).toBe(200);
  });
});
