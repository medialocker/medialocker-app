import { getConfig } from '@medialocker/config';

/**
 * Brand tokens for transactional email. Colors come from the marketing site
 * (accent `#6D5EF6`, dark surface `#15151C`); the content card itself is light
 * for readability across email clients, with the dark bar reserved for the
 * header. Voice per medialocker-web/BRAND.md: "plain, reassuring, specific —
 * always show the number and the next step."
 */
export interface Theme {
  brandName: string;
  /** Primary accent — buttons, links. */
  accent: string;
  /** Dark header/footer surface. */
  dark: string;
  /** Body text on the light card. */
  text: string;
  /** Muted/secondary text. */
  muted: string;
  /** Page background behind the card. */
  pageBg: string;
  logoUrl: string;
  supportEmail: string;
  /** `https://app.<domain>` — the dashboard. */
  appUrl: string;
  /** `https://<domain>` — the marketing site. */
  marketingUrl: string;
  /** One-line footer identity. */
  companyLine: string;
}

export function getTheme(): Theme {
  const cfg = getConfig();
  return {
    brandName: 'MediaLocker',
    accent: '#6D5EF6',
    dark: '#15151C',
    text: '#1A1A22',
    muted: '#6B6B76',
    pageBg: '#F4F4F7',
    logoUrl: cfg.EMAIL_LOGO_URL,
    supportEmail: cfg.CONTACT_INBOX,
    appUrl: `https://app.${cfg.PUBLIC_BASE_DOMAIN}`,
    marketingUrl: `https://${cfg.PUBLIC_BASE_DOMAIN}`,
    companyLine: 'MediaLocker · Real S3 storage for media creators',
  };
}
