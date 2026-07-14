import { renderAndSend, type EmailTemplate } from '../render.js';
import { button } from '../layout.js';
import { getTheme } from '../theme.js';
import type { SendResult } from '../send.js';

export interface ReceiptView {
  tier: string;
  amountFormatted: string;
  periodEnd: string;
  invoiceUrl?: string;
}

const template: EmailTemplate = {
  subject: () => 'Your MediaLocker receipt',
  html: `
<h1 style="margin:0 0 16px;font-size:20px;color:{{text}};">Thanks — payment received</h1>
<p style="margin:0 0 14px;">We charged <strong>{{amountFormatted}}</strong> for your <strong>{{tier}}</strong> plan. Your next renewal is <strong>{{periodEnd}}</strong>.</p>
{{#invoiceUrl}}<p style="margin:0;">{{{ctaButton}}}</p>{{/invoiceUrl}}
`,
  text: `Thanks — payment received.

We charged {{{amountFormatted}}} for your {{{tier}}} plan. Your next renewal is {{{periodEnd}}}.
{{#invoiceUrl}}
View your invoice: {{{invoiceUrl}}}{{/invoiceUrl}}`,
};

export function sendReceiptEmail(to: string, view: ReceiptView): Promise<SendResult> {
  const theme = getTheme();
  return renderAndSend(template, to, {
    ...view,
    ctaButton: view.invoiceUrl ? button(view.invoiceUrl, 'View invoice', theme) : '',
  });
}
