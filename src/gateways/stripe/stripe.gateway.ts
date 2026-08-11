import Stripe from 'stripe';
import type {
  Capability,
  SupportsCheckout,
  SupportsRefunds,
  SupportsWebhooks,
} from '../../capabilities';
import { ConfigurationError, GatewayError, WebhookVerificationError } from '../../errors';
import { toMajorUnit, toMinorUnit } from '../../money';
import type {
  CaptureRequest,
  CaptureResult,
  CheckoutRequest,
  CheckoutResult,
  RefundRequest,
  RefundResult,
  WebhookEvent,
  WebhookRequest,
} from '../../types';
import { STRIPE_CURRENCIES } from './stripe.currencies';
import type { StripeOptions } from './stripe.options';

const GATEWAY_ID = 'stripe';

/**
 * Stripe, through the official SDK.
 *
 * The client is constructed per gateway instance from the key this gateway was given.
 * Nothing here reads a process-global, so two gateways serving different tenants in one
 * process cannot transact through each other's account.
 */
class StripeGateway implements SupportsCheckout, SupportsRefunds, SupportsWebhooks {
  readonly id = GATEWAY_ID;

  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'checkout',
    'refund',
    'webhooks',
  ]);

  readonly currencies: ReadonlySet<string> | null = STRIPE_CURRENCIES;

  protected readonly client: Stripe;

  constructor(protected readonly options: StripeOptions) {
    if (!options.apiKey) throw new ConfigurationError(GATEWAY_ID, 'apiKey is required');

    // No apiVersion override: the SDK pins its own, and overriding it here would
    // silently change response shapes on upgrade.
    this.client = new Stripe(options.apiKey, {
      ...(options.httpClient ? { httpClient: options.httpClient } : {}),
    });
  }

  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    this.assertCurrency(request.currency);

    const session = await this.call(() =>
      this.client.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: request.reference,
        success_url: `${request.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: request.cancelUrl,
        ...(request.customerEmail ? { customer_email: request.customerEmail } : {}),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: request.currency.toLowerCase(),
              unit_amount: toMinorUnit(request.amount, request.currency),
              product_data: { name: request.description ?? request.reference },
            },
          },
        ],
        metadata: { reference: request.reference, ...(request.metadata ?? {}) },
      }),
    );

    if (!session.url) {
      throw new GatewayError(GATEWAY_ID, 'Stripe returned a session without a checkout url');
    }

    return { status: 'redirect', gateway: GATEWAY_ID, sessionId: session.id, url: session.url };
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const session = await this.call(() =>
      this.client.checkout.sessions.retrieve(request.sessionId),
    );

    if (session.payment_status !== 'paid') {
      return { status: 'pending', gateway: GATEWAY_ID, sessionId: request.sessionId };
    }

    // A paid session must carry a payment intent and a currency. Substituting the
    // session id or a default currency here would hand the caller a transactionId that
    // refund() cannot use, and an amount denominated in the wrong currency - both of
    // which surface far from the cause.
    const transactionId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;

    if (!transactionId) {
      throw new GatewayError(
        GATEWAY_ID,
        `Session ${request.sessionId} is paid but carries no payment intent`,
      );
    }

    if (!session.currency) {
      throw new GatewayError(
        GATEWAY_ID,
        `Session ${request.sessionId} is paid but has no currency`,
      );
    }

    if (session.amount_total === null || session.amount_total === undefined) {
      throw new GatewayError(GATEWAY_ID, `Session ${request.sessionId} is paid but has no total`);
    }

    const currency = session.currency.toUpperCase();

    return {
      status: 'paid',
      gateway: GATEWAY_ID,
      sessionId: request.sessionId,
      transactionId,
      amount: toMajorUnit(session.amount_total, currency),
      currency,
      ...(session.client_reference_id ? { reference: session.client_reference_id } : {}),
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const refund = await this.call(() =>
      this.client.refunds.create({
        payment_intent: request.transactionId,
        // Omitting `amount` tells Stripe to refund in full.
        ...(request.amount === undefined
          ? {}
          : { amount: toMinorUnit(request.amount, request.currency) }),
      }),
    );

    const currency = (refund.currency || request.currency).toUpperCase();

    return {
      gateway: GATEWAY_ID,
      refundId: refund.id,
      amount: toMajorUnit(refund.amount, currency),
      currency,
      status:
        refund.status === 'succeeded'
          ? 'succeeded'
          : refund.status === 'failed'
            ? 'failed'
            : 'pending',
    };
  }

  // Async so that every failure surfaces as a rejected promise rather than a
  // synchronous throw. Callers should only ever need one error path.
  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyWebhook(request: WebhookRequest): Promise<WebhookEvent> {
    const secret = this.options.webhookSecret;
    if (!secret) {
      throw new ConfigurationError(GATEWAY_ID, 'webhookSecret is required to verify webhooks');
    }

    const raw = request.headers['stripe-signature'];
    const signature = Array.isArray(raw) ? raw[0] : raw;
    if (!signature) {
      throw new WebhookVerificationError(GATEWAY_ID, 'missing Stripe-Signature header');
    }

    try {
      // constructEvent does the timing-safe compare and the timestamp tolerance check.
      // Reimplementing either is how signature verification gets subtly wrong.
      const event = this.client.webhooks.constructEvent(
        request.rawBody,
        signature,
        secret,
        this.options.webhookTolerance,
      );

      const object = event.data.object as {
        id?: string;
        client_reference_id?: string;
        metadata?: Record<string, string>;
      };
      const reference = object.client_reference_id ?? object.metadata?.['reference'];

      return {
        gateway: GATEWAY_ID,
        type: event.type,
        id: event.id,
        ...(object.id ? { sessionId: object.id } : {}),
        ...(reference ? { reference } : {}),
        payload: event,
      };
    } catch (error) {
      throw new WebhookVerificationError(
        GATEWAY_ID,
        error instanceof Error ? error.message : 'signature verification failed',
      );
    }
  }

  protected assertCurrency(currency: string): void {
    if (this.currencies && !this.currencies.has(currency.toUpperCase())) {
      throw new GatewayError(GATEWAY_ID, `Currency '${currency}' is not supported`);
    }
  }

  /** Wrap every SDK call so callers only ever see the PaymentError family. */
  protected async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        // The message is safe; the raw body is not, and is deliberately dropped.
        throw new GatewayError(GATEWAY_ID, error.message, error.statusCode);
      }
      throw error;
    }
  }
}

export function createStripeGateway(options: StripeOptions): StripeGateway {
  return new StripeGateway(options);
}

export type { StripeGateway };
