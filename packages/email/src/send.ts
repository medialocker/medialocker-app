import { getConfig } from '@medialocker/config';
import { createLogger } from '@medialocker/observability';
import { getResend } from './client.js';

const log = createLogger('email');

export interface SendResult {
  sent: boolean;
  /** True when email is disabled (no RESEND_API_KEY) — not an error. */
  skipped?: boolean;
  id?: string;
  error?: string;
}

export interface DispatchInput {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

/**
 * Low-level send. Never throws — returns a `SendResult` so lifecycle callers can
 * fire-and-forget best-effort, while the contact route can inspect `sent`.
 */
export async function dispatch(input: DispatchInput): Promise<SendResult> {
  const resend = getResend();
  if (!resend) {
    log.info(
      { to: input.to, subject: input.subject },
      'Email disabled (no RESEND_API_KEY) — skipping send',
    );
    return { sent: false, skipped: true };
  }

  const cfg = getConfig();
  try {
    const { data, error } = await resend.emails.send({
      from: cfg.EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    });

    if (error) {
      log.error(
        { err: error, to: input.to, subject: input.subject },
        'Resend rejected email',
      );
      return { sent: false, error: error.message ?? 'send failed' };
    }

    log.info({ id: data?.id, to: input.to, subject: input.subject }, 'Email sent');
    return { sent: true, id: data?.id };
  } catch (err) {
    log.error({ err, to: input.to, subject: input.subject }, 'Email send threw');
    return { sent: false, error: err instanceof Error ? err.message : 'send failed' };
  }
}
