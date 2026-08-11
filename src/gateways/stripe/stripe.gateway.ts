import Stripe from 'stripe';
import type { Capability, SupportsCheckout } from '../../capabilities';
import { ConfigurationError, GatewayError } from '../../errors';
import { toMajorUnit, toMinorUnit } from '../../money';
import type { CaptureRequest, CaptureResult, CheckoutRequest, CheckoutResult } from '../../types';
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
class StripeGateway implements SupportsCheckout {
  readonly id = GATEWAY_ID;

  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['checkout']);

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

    const currency = (session.currency ?? 'usd').toUpperCase();

    return {
      status: 'paid',
      gateway: GATEWAY_ID,
      sessionId: request.sessionId,
      transactionId:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent?.id ?? request.sessionId),
      amount: toMajorUnit(session.amount_total ?? 0, currency),
      currency,
      ...(session.client_reference_id ? { reference: session.client_reference_id } : {}),
    };
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
