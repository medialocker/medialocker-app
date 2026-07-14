import Mustache from 'mustache';
import { getTheme } from './theme.js';
import { wrapHtml, wrapText } from './layout.js';
import { dispatch, type SendResult } from './send.js';

/**
 * A template is content-only (no layout). Convention:
 *   - `html` uses Mustache `{{ }}` — HTML-escaped (safe for user content).
 *   - `text` uses Mustache `{{{ }}}` — raw (plain text needs no HTML escaping).
 * Precomputed HTML fragments (e.g. a CTA button, an nl2br message) are passed in
 * the view and interpolated with `{{{ }}}` in the `html` body.
 */
export interface EmailTemplate {
  subject: (view: Record<string, unknown>) => string;
  html: string;
  text: string;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

/** Render a template + view into a full branded { subject, html, text }. */
export function renderEmail(t: EmailTemplate, view: Record<string, unknown>): Rendered {
  const theme = getTheme();
  const merged = { ...theme, ...view };
  const subject = t.subject(merged);
  const htmlBody = Mustache.render(t.html, merged);
  const textBody = Mustache.render(t.text, merged);
  return {
    subject,
    html: wrapHtml(htmlBody, subject, theme),
    text: wrapText(textBody, theme),
  };
}

/** Render then dispatch. Returns the underlying SendResult (never throws). */
export function renderAndSend(
  t: EmailTemplate,
  to: string | string[],
  view: Record<string, unknown>,
  opts?: { replyTo?: string },
): Promise<SendResult> {
  const { subject, html, text } = renderEmail(t, view);
  return dispatch({ to, subject, html, text, replyTo: opts?.replyTo });
}
