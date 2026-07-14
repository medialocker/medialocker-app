import { renderAndSend, type EmailTemplate } from '../render.js';
import { button } from '../layout.js';
import { getTheme } from '../theme.js';
import type { SendResult } from '../send.js';

export interface CapacityAddedView {
  addedGb: number;
  newTotalGb: number;
  costFormatted: string;
  /** True when auto-capacity added it (near limit); false for a manual add. */
  auto: boolean;
}

const template: EmailTemplate = {
  subject: (v) =>
    v['auto'] ? 'We added storage to keep your uploads going' : 'Storage added to your plan',
  html: `
<h1 style="margin:0 0 16px;font-size:20px;color:{{text}};">{{addedGb}} GB added</h1>
{{#auto}}<p style="margin:0 0 14px;">You were close to your storage limit, so we automatically added <strong>{{addedGb}} GB</strong> ({{costFormatted}}, prorated) to keep your uploads flowing. You're now at <strong>{{newTotalGb}} GB</strong>.</p>
<p style="margin:0 0 22px;">Prefer to control this? You can set a monthly spend cap or turn auto-capacity off in settings.</p>{{/auto}}
{{^auto}}<p style="margin:0 0 22px;">We added <strong>{{addedGb}} GB</strong> ({{costFormatted}}, prorated) to your plan. You're now at <strong>{{newTotalGb}} GB</strong>.</p>{{/auto}}
<p style="margin:0;">{{{ctaButton}}}</p>
`,
  text: `{{{addedGb}}} GB added.

{{#auto}}You were close to your storage limit, so we automatically added {{{addedGb}}} GB ({{{costFormatted}}}, prorated) to keep your uploads flowing. You're now at {{{newTotalGb}}} GB.

Prefer to control this? Set a monthly spend cap or turn auto-capacity off in settings.{{/auto}}{{^auto}}We added {{{addedGb}}} GB ({{{costFormatted}}}, prorated) to your plan. You're now at {{{newTotalGb}}} GB.{{/auto}}

Manage capacity: {{{dashboardUrl}}}`,
};

export function sendCapacityAddedEmail(to: string, view: CapacityAddedView): Promise<SendResult> {
  const theme = getTheme();
  const dashboardUrl = `${theme.appUrl}/settings/billing`;
  return renderAndSend(template, to, {
    ...view,
    dashboardUrl,
    ctaButton: button(dashboardUrl, 'Manage capacity', theme),
  });
}
