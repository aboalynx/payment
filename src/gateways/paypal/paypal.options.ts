export interface PaypalOptions {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'production';

  /** Required only for `verifyWebhook`. Created in the PayPal dashboard. */
  webhookId?: string;
}

/**
 * REST host per environment.
 *
 * Also used by webhook verification, which bypasses the SDK because it ships no
 * webhooks controller.
 */
export function paypalApiBase(environment: PaypalOptions['environment']): string {
  return environment === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}
