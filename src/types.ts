/**
 * The vocabulary every gateway speaks.
 *
 * Deliberately provider-neutral: nothing here mentions Stripe sessions or PayPal
 * orders, because calling code must not change when the provider does.
 */

/** ISO-4217 code, e.g. 'USD', 'KWD', 'JPY'. */
export type CurrencyCode = string;

export interface CheckoutRequest {
  /** Your own order or invoice id. Round-trips back on capture and webhooks. */
  reference: string;
  /** Major units — 49.99, not 4999. Conversion is the gateway's problem. */
  amount: number;
  currency: CurrencyCode;
  successUrl: string;
  cancelUrl: string;
  description?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}

/**
 * Discriminated on `status` so the compiler forces both shapes to be handled. Most
 * providers redirect; some hand back a reference the customer pays offline.
 */
export type CheckoutResult =
  | { status: 'redirect'; gateway: string; sessionId: string; url: string }
  | { status: 'reference'; gateway: string; sessionId: string; code: string };

export interface CaptureRequest {
  /** The `sessionId` returned by checkout, which you persisted. */
  sessionId: string;
}

export type CaptureResult =
  | {
      status: 'paid';
      gateway: string;
      sessionId: string;
      /** Use this to refund later. */
      transactionId: string;
      amount: number;
      currency: CurrencyCode;
      reference?: string;
    }
  | { status: 'pending'; gateway: string; sessionId: string }
  | { status: 'failed'; gateway: string; sessionId: string; reason: string };

export interface RefundRequest {
  transactionId: string;
  currency: CurrencyCode;
  /** Omit for a full refund. Major units. */
  amount?: number;
}

export interface RefundResult {
  gateway: string;
  refundId: string;
  amount: number;
  currency: CurrencyCode;
  status: 'succeeded' | 'pending' | 'failed';
}

export interface WebhookRequest {
  /**
   * The UNPARSED body. Signature schemes hash the exact bytes sent, so parsing and
   * re-serialising changes key order and whitespace and never verifies. Configure a
   * raw-body parser on the route.
   */
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface WebhookEvent {
  gateway: string;
  /** Provider-native event name, e.g. 'checkout.session.completed'. */
  type: string;
  /** Stable per event. The application uses this for idempotency. */
  id: string;
  sessionId?: string;
  reference?: string;
  payload: unknown;
}

/** Emitted for observability. Never carries a credential or customer PII. */
export type PaymentEvent =
  | { name: 'checkout.created'; gateway: string; reference: string; sessionId: string }
  | { name: 'checkout.failed'; gateway: string; reference: string; error: string }
  | { name: 'payment.captured'; gateway: string; sessionId: string; transactionId: string }
  | { name: 'payment.failed'; gateway: string; sessionId: string; reason: string }
  | { name: 'refund.created'; gateway: string; refundId: string }
  | { name: 'webhook.verified'; gateway: string; type: string; id: string }
  | { name: 'webhook.rejected'; gateway: string; reason: string };
