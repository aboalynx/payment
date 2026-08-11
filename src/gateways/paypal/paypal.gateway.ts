import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  OrderStatus,
  PaymentsController,
  PaypalExperienceUserAction,
  RefundStatus,
} from '@paypal/paypal-server-sdk';
import type { Capability, SupportsCheckout, SupportsRefunds } from '../../capabilities';
import { ConfigurationError, GatewayError } from '../../errors';
import { toDecimalString } from '../../money';
import type {
  CaptureRequest,
  CaptureResult,
  CheckoutRequest,
  CheckoutResult,
  RefundRequest,
  RefundResult,
} from '../../types';
import { PAYPAL_CURRENCIES } from './paypal.currencies';
import type { PaypalOptions } from './paypal.options';

const GATEWAY_ID = 'paypal';

/**
 * PayPal, through the official SDK.
 *
 * Amounts are decimal strings here, not minor units — the Orders API takes
 * `{ value: "49.90", currencyCode: "USD" }`. That is a genuine difference from Stripe,
 * not an oversight.
 */
class PaypalGateway implements SupportsCheckout, SupportsRefunds {
  readonly id = GATEWAY_ID;

  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['checkout', 'refund']);

  readonly currencies: ReadonlySet<string> | null = PAYPAL_CURRENCIES;

  protected readonly orders: OrdersController;

  protected readonly payments: PaymentsController;

  constructor(protected readonly options: PaypalOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new ConfigurationError(GATEWAY_ID, 'clientId and clientSecret are required');
    }

    // Credentials live on this client instance. The SDK performs and caches the
    // OAuth client-credentials exchange internally.
    const client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: options.clientId,
        oAuthClientSecret: options.clientSecret,
      },
      environment:
        options.environment === 'production' ? Environment.Production : Environment.Sandbox,
    });

    this.orders = new OrdersController(client);
    this.payments = new PaymentsController(client);
  }

  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    this.assertCurrency(request.currency);

    const { result } = await this.call(() =>
      this.orders.createOrder({
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              referenceId: request.reference,
              ...(request.description ? { description: request.description } : {}),
              amount: {
                currencyCode: request.currency.toUpperCase(),
                value: toDecimalString(request.amount, request.currency),
              },
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                userAction: PaypalExperienceUserAction.PayNow,
                returnUrl: request.successUrl,
                cancelUrl: request.cancelUrl,
              },
            },
          },
        },
      }),
    );

    const url = result.links?.find((link) => link.rel === 'payer-action')?.href;
    if (!url) {
      throw new GatewayError(GATEWAY_ID, 'PayPal returned no payer-action link');
    }

    return { status: 'redirect', gateway: GATEWAY_ID, sessionId: result.id ?? '', url };
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const { result } = await this.call(() => this.orders.captureOrder({ id: request.sessionId }));

    const unit = result.purchaseUnits?.[0];
    const capture = unit?.payments?.captures?.[0];

    if (result.status !== OrderStatus.Completed || !capture) {
      return { status: 'pending', gateway: GATEWAY_ID, sessionId: request.sessionId };
    }

    return {
      status: 'paid',
      gateway: GATEWAY_ID,
      sessionId: request.sessionId,
      transactionId: capture.id ?? '',
      amount: Number(capture.amount?.value ?? '0'),
      currency: capture.amount?.currencyCode ?? 'USD',
      ...(unit?.referenceId ? { reference: unit.referenceId } : {}),
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const { result } = await this.call(() =>
      this.payments.refundCapturedPayment({
        captureId: request.transactionId,
        // Omitting the body refunds in full.
        ...(request.amount === undefined
          ? {}
          : {
              body: {
                amount: {
                  currencyCode: request.currency.toUpperCase(),
                  value: toDecimalString(request.amount, request.currency),
                },
              },
            }),
      }),
    );

    return {
      gateway: GATEWAY_ID,
      refundId: result.id ?? '',
      amount: Number(result.amount?.value ?? '0'),
      currency: result.amount?.currencyCode ?? request.currency.toUpperCase(),
      status:
        result.status === RefundStatus.Completed
          ? 'succeeded'
          : result.status === RefundStatus.Failed
            ? 'failed'
            : 'pending',
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
      if (error instanceof ApiError) {
        // `error.message` is safe. The response body echoes the request back and is dropped.
        throw new GatewayError(GATEWAY_ID, error.message, error.statusCode);
      }
      throw error;
    }
  }
}

export function createPaypalGateway(options: PaypalOptions): PaypalGateway {
  return new PaypalGateway(options);
}

export type { PaypalGateway };
