import { renderAndSend, type EmailTemplate } from '../render.js';
import { button } from '../layout.js';
import { getTheme } from '../theme.js';
import type { SendResult } from '../send.js';

export interface WelcomeView {
  orgName: string;
  tier: string;
  includedGb: number;
  dashboardUrl: string;
}

const template: EmailTemplate = {
  subject: () => 'Welcome to MediaLocker — your storage is ready',
  html: `
<h1 style="margin:0 0 16px;font-size:20px;color:{{text}};">Your storage is ready</h1>
<p style="margin:0 0 14px;"><strong>{{orgName}}</strong> is set up on the <strong>{{tier}}</strong> plan with <strong>{{includedGb}} GB</strong> included — real S3 buckets, free egress, no surprises.</p>
<p style="margin:0 0 22px;">Your default bucket and API key are waiting in the dashboard. Your secret key is shown once, so copy it now.</p>
<p style="margin:0;">{{{ctaButton}}}</p>
`,
  text: `Your storage is ready.

{{{orgName}}} is set up on the {{{tier}}} plan with {{{includedGb}}} GB included — real S3 buckets, free egress, no surprises.

Your default bucket and API key are waiting in the dashboard (your secret key is shown once, so copy it now):
{{{dashboardUrl}}}`,
};

export function sendWelcomeEmail(to: string, view: WelcomeView): Promise<SendResult> {
  const theme = getTheme();
  return renderAndSend(template, to, {
    ...view,
    ctaButton: button(view.dashboardUrl, 'Open your dashboard', theme),
  });
}
