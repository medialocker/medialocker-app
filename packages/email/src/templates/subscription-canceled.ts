import { renderAndSend, type EmailTemplate } from '../render.js';
import { button } from '../layout.js';
import { getTheme } from '../theme.js';
import type { SendResult } from '../send.js';

export interface SubscriptionCanceledView {
  tier: string;
  /** Human date the paid access runs until. */
  accessUntil: string;
}

const template: EmailTemplate = {
  subject: () => 'Your MediaLocker plan has been canceled',
  html: `
<h1 style="margin:0 0 16px;font-size:20px;color:{{text}};">Your plan is canceled</h1>
<p style="margin:0 0 14px;">Your <strong>{{tier}}</strong> plan is canceled. You keep access until <strong>{{accessUntil}}</strong>, and your media stays exactly where it is — nothing is deleted.</p>
<p style="margin:0 0 22px;">Changed your mind? You can resubscribe anytime and pick up right where you left off.</p>
<p style="margin:0;">{{{ctaButton}}}</p>
`,
  text: `Your plan is canceled.

Your {{{tier}}} plan is canceled. You keep access until {{{accessUntil}}}, and your media stays exactly where it is — nothing is deleted.

Changed your mind? Resubscribe anytime:
{{{pricingUrl}}}`,
};

export function sendSubscriptionCanceledEmail(
  to: string,
  view: SubscriptionCanceledView,
): Promise<SendResult> {
  const theme = getTheme();
  const pricingUrl = `${theme.marketingUrl}/pricing`;
  return renderAndSend(template, to, {
    ...view,
    pricingUrl,
    ctaButton: button(pricingUrl, 'View plans', theme),
  });
}
