import { renderAndSend, type EmailTemplate } from '../render.js';
import { button } from '../layout.js';
import { getTheme } from '../theme.js';
import type { SendResult } from '../send.js';

export interface PaymentFailedView {
  tier: string;
  amountDueFormatted: string;
  updatePaymentUrl: string;
}

const template: EmailTemplate = {
  subject: () => 'Action needed: your MediaLocker payment failed',
  html: `
<h1 style="margin:0 0 16px;font-size:20px;color:{{text}};">Your payment didn't go through</h1>
<p style="margin:0 0 14px;">We couldn't collect <strong>{{amountDueFormatted}}</strong> for your <strong>{{tier}}</strong> plan. Your media is safe and still here — but automatic capacity top-ups are paused until the payment clears.</p>
<p style="margin:0 0 22px;">Update your payment method and we'll retry right away.</p>
<p style="margin:0;">{{{ctaButton}}}</p>
`,
  text: `Your payment didn't go through.

We couldn't collect {{{amountDueFormatted}}} for your {{{tier}}} plan. Your media is safe and still here — but automatic capacity top-ups are paused until the payment clears.

Update your payment method and we'll retry right away:
{{{updatePaymentUrl}}}`,
};

export function sendPaymentFailedEmail(to: string, view: PaymentFailedView): Promise<SendResult> {
  const theme = getTheme();
  return renderAndSend(template, to, {
    ...view,
    ctaButton: button(view.updatePaymentUrl, 'Update payment method', theme),
  });
}
