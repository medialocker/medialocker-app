import { renderAndSend, type EmailTemplate } from '../render.js';
import { nl2brEscaped } from '../layout.js';
import type { SendResult } from '../send.js';

export interface ContactMessage {
  name: string;
  email: string;
  subject: string;
  message: string;
}

/**
 * Notification to the support inbox for a website contact submission. The
 * submitter's address is set as Reply-To so a reply goes straight to them.
 * The free-text `message` is HTML-escaped + nl2br'd before interpolation
 * (`{{{messageHtml}}}`) — never inject raw user input into the HTML body.
 */
const notificationTemplate: EmailTemplate = {
  subject: (v) => `Contact form: ${v['subject']}`,
  html: `
<h1 style="margin:0 0 16px;font-size:20px;color:{{text}};">New contact submission</h1>
<p style="margin:0 0 6px;"><strong>From:</strong> {{name}} &lt;{{email}}&gt;</p>
<p style="margin:0 0 16px;"><strong>Subject:</strong> {{subject}}</p>
<div style="margin:0;padding:16px;background:#F7F7FA;border-radius:8px;">{{{messageHtml}}}</div>
`,
  text: `New contact submission

From: {{{name}}} <{{{email}}}>
Subject: {{{subject}}}

{{{message}}}`,
};

export function sendContactNotification(
  to: string,
  msg: ContactMessage,
): Promise<SendResult> {
  return renderAndSend(
    notificationTemplate,
    to,
    { ...msg, messageHtml: nl2brEscaped(msg.message) },
    { replyTo: msg.email },
  );
}

/** Optional auto-acknowledgement to the person who submitted the form. */
const ackTemplate: EmailTemplate = {
  subject: () => 'Thanks for reaching out to MediaLocker',
  html: `
<h1 style="margin:0 0 16px;font-size:20px;color:{{text}};">We got your message</h1>
<p style="margin:0 0 14px;">Thanks, {{name}} — we've received your message and a human will get back to you at <strong>{{email}}</strong>, usually within one business day.</p>
<p style="margin:0;">— The MediaLocker team</p>
`,
  text: `We got your message.

Thanks, {{{name}}} — we've received your message and a human will get back to you at {{{email}}}, usually within one business day.

— The MediaLocker team`,
};

export function sendContactAck(to: string, view: { name: string; email: string }): Promise<SendResult> {
  return renderAndSend(ackTemplate, to, view);
}
