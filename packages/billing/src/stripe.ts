import Stripe from 'stripe';
import { getConfig } from '@medialocker/config';

let _stripe: Stripe | null = null;

export type StripeClient = Stripe;

/**
 * The single pinned Stripe API version (§26 "Pin the Stripe API version … so
 * behavior is deterministic"). Every `new Stripe(...)` across the monorepo must
 * use this exact value so all services interpret the same account identically.
 * This is the version the installed `stripe` SDK's types target.
 */
export const STRIPE_API_VERSION = '2025-02-24.acacia' as const;

export function getStripeClient(): Stripe {
  if (!_stripe) {
    const config = getConfig();
    if (!config.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    _stripe = new Stripe(config.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
      typescript: true,
    });
  }
  return _stripe;
}

export function getStripe(): Stripe {
  return getStripeClient();
}
