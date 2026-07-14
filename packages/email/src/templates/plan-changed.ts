import { renderAndSend, type EmailTemplate } from '../render.js';
import { button } from '../layout.js';
import { getTheme } from '../theme.js';
import type { SendResult } from '../send.js';

export interface PlanChangedView {
  fromTier: string;
  toTier: string;
  effectiveDate: string;
}

const template: EmailTemplate = {
  subject: () => 'Your MediaLocker plan changed',
  html: `
<h1 style="margin:0 0 16px;font-size:20px;color:{{text}};">Your plan changed</h1>
<p style="margin:0 0 14px;">You moved from <strong>{{fromTier}}</strong> to <strong>{{toTier}}</strong>, effective <strong>{{effectiveDate}}</strong>. Your included storage and pricing update to match.</p>
<p style="margin:0;">{{{ctaButton}}}</p>
`,
  text: `Your plan changed.

You moved from {{{fromTier}}} to {{{toTier}}}, effective {{{effectiveDate}}}. Your included storage and pricing update to match.

Manage your plan: {{{dashboardUrl}}}`,
};

export function sendPlanChangedEmail(to: string, view: PlanChangedView): Promise<SendResult> {
  const theme = getTheme();
  const dashboardUrl = `${theme.appUrl}/settings/billing`;
  return renderAndSend(template, to, {
    ...view,
    dashboardUrl,
    ctaButton: button(dashboardUrl, 'Manage plan', theme),
  });
}
