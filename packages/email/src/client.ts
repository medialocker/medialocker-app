import { Resend } from 'resend';
import { getConfig } from '@medialocker/config';

let _resend: Resend | null = null;
let _initialized = false;

/**
 * Lazy Resend singleton. Returns `null` when `RESEND_API_KEY` is unset —
 * callers treat that as "email disabled" and no-op (dev/CI/test default), the
 * same graceful-degradation shape as the Stripe client.
 */
export function getResend(): Resend | null {
  if (!_initialized) {
    const cfg = getConfig();
    _resend = cfg.RESEND_API_KEY ? new Resend(cfg.RESEND_API_KEY) : null;
    _initialized = true;
  }
  return _resend;
}

/** Clear the memoized client (used by tests after re-stubbing env). */
export function resetResend(): void {
  _resend = null;
  _initialized = false;
}
