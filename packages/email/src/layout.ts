import type { Theme } from './theme.js';

/** HTML-escape a raw string for safe interpolation into HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape then convert newlines to <br> — for multi-line user content in HTML. */
export function nl2brEscaped(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

/**
 * Wrap a rendered content fragment in the shared branded HTML shell. Uses only
 * inline styles + a max-width container (email-client safe). `preheader` is the
 * hidden inbox-preview snippet.
 */
export function wrapHtml(bodyHtml: string, preheader: string, t: Theme): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(t.brandName)}</title>
</head>
<body style="margin:0;padding:0;background:${t.pageBg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.pageBg};padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:92%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E7E7EE;">
      <tr><td style="background:${t.dark};padding:22px 32px;">
        <a href="${t.marketingUrl}" style="text-decoration:none;">
          <img src="${t.logoUrl}" alt="${escapeHtml(t.brandName)}" height="26" style="height:26px;display:block;border:0;">
        </a>
      </td></tr>
      <tr><td style="padding:32px;color:${t.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;">
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:20px 32px;border-top:1px solid #EDEDF2;color:${t.muted};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;">
        ${escapeHtml(t.companyLine)}<br>
        Questions? <a href="mailto:${t.supportEmail}" style="color:${t.accent};text-decoration:none;">${escapeHtml(t.supportEmail)}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Wrap a rendered plain-text fragment with a simple header/footer. */
export function wrapText(bodyText: string, t: Theme): string {
  return `${t.brandName}\n\n${bodyText.trim()}\n\n—\n${t.companyLine}\nQuestions? ${t.supportEmail}\n`;
}

/** Inline-styled CTA button for HTML bodies. */
export function button(href: string, label: string, t: Theme): string {
  return `<a href="${href}" style="display:inline-block;background:${t.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">${escapeHtml(label)}</a>`;
}
