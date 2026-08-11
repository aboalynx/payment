import type Stripe from 'stripe';

export interface StripeOptions {
  /** Secret key. Held on the gateway instance, never set globally. */
  apiKey: string;

  /** Required only for `verifyWebhook`. */
  webhookSecret?: string;

  /** Signature age tolerance in seconds. Defaults to Stripe's own 300. */
  webhookTolerance?: number;

  /** Test seam. Applications never set this. */
  httpClient?: Stripe.StripeConfig['httpClient'];
}
