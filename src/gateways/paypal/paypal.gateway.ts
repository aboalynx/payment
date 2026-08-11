import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  type Order,
  OrdersController,
  OrderStatus,
  PaymentsController,
  PaypalExperienceUserAction,
  RefundStatus,
} from '@paypal/paypal-server-sdk';
import type {
  Capability,
  SupportsCheckout,
  SupportsRefunds,
  SupportsWebhooks,
} from '../../capabilities';
import { ConfigurationError, GatewayError } from '../../errors';
import { toDecimalString } from '../../money';
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
import { PAYPAL_CURRENCIES } from './paypal.currencies';
import { paypalApiBase, type PaypalOptions } from './paypal.options';
import { verifyPaypalWebhook } from './paypal.webhooks';

const GATEWAY_ID = 'paypal';

/** Renew this many seconds before the token actually expires. */
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;

/**
 * PayPal, through the official SDK.
 *
 * Amounts are decimal strings here, not minor units — the Orders API takes
 * `{ value: "49.90", currencyCode: "USD" }`. That is a genuine difference from Stripe,
 * not an oversight.
 */
class PaypalGateway implements SupportsCheckout, SupportsRefunds, SupportsWebhooks {
  readonly id = GATEWAY_ID;

  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'checkout',
    'refund',
    'webhooks',
  ]);

  readonly currencies: ReadonlySet<string> | null = PAYPAL_CURRENCIES;

  protected readonly orders: OrdersController;

  protected readonly payments: PaymentsController;

  private cachedToken?: { value: string; expiresAt: number };

  /** Shared so concurrent callers await one exchange rather than starting several. */
  private tokenRequest?: Promise<string>;

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

    // An empty sessionId would be accepted here and fail later at capture time.
    if (!result.id) {
      throw new GatewayError(GATEWAY_ID, 'PayPal returned an order with no id');
    }

    return { status: 'redirect', gateway: GATEWAY_ID, sessionId: result.id, url };
  }

  /**
   * Capture an approved order.
   *
   * Idempotent, deliberately. PayPal's captureOrder moves money and rejects a second
   * call with 422 ORDER_ALREADY_CAPTURED, whereas Stripe's equivalent is a status read
   * that can be repeated freely. Without this, `capture()` would mean two different
   * things depending on the gateway, in a package whose whole premise is that it does
   * not. On the already-captured path the existing capture is read back instead.
   */
  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const result = await this.captureOrReadBack(request.sessionId);

    const unit = result.purchaseUnits?.[0];
    const capture = unit?.payments?.captures?.[0];

    if (result.status !== OrderStatus.Completed || !capture) {
      return { status: 'pending', gateway: GATEWAY_ID, sessionId: request.sessionId };
    }

    // transactionId is what refund() is later called with, and currency decides what
    // the amount means. Defaulting either would move the failure far from its cause.
    if (!capture.id) {
      throw new GatewayError(GATEWAY_ID, `Order ${request.sessionId} captured with no capture id`);
    }

    if (!capture.amount?.currencyCode || capture.amount.value === undefined) {
      throw new GatewayError(GATEWAY_ID, `Capture ${capture.id} is missing its amount or currency`);
    }

    return {
      status: 'paid',
      gateway: GATEWAY_ID,
      sessionId: request.sessionId,
      transactionId: capture.id,
      amount: Number(capture.amount.value),
      currency: capture.amount.currencyCode,
      ...(unit?.referenceId ? { reference: unit.referenceId } : {}),
    };
  }

  /** captureOrder, falling back to getOrder when the order was already captured. */
  protected async captureOrReadBack(orderId: string): Promise<Order> {
    try {
      const { result } = await this.orders.captureOrder({ id: orderId });
      return result;
    } catch (error) {
      if (!this.isAlreadyCaptured(error)) {
        this.rethrow(error);
      }

      const { result } = await this.call(() => this.orders.getOrder({ id: orderId }));
      return result;
    }
  }

  /**
   * PayPal reports a repeat capture as 422 with an ORDER_ALREADY_CAPTURED issue.
   *
   * The `issue` field is compared rather than substring-matching the body: the string
   * can appear in a description or an echoed debug id, and a false positive here would
   * silently turn a genuine failure into a read-back of an unrelated capture.
   */
  protected isAlreadyCaptured(error: unknown): boolean {
    if (!(error instanceof ApiError) || error.statusCode !== 422) return false;
    if (typeof error.body !== 'string') return false;

    let parsed: { details?: { issue?: string }[] };
    try {
      parsed = JSON.parse(error.body) as typeof parsed;
    } catch {
      return false;
    }

    return parsed.details?.some((detail) => detail.issue === 'ORDER_ALREADY_CAPTURED') ?? false;
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

    if (!result.id) {
      throw new GatewayError(GATEWAY_ID, 'PayPal returned a refund with no id');
    }

    if (!result.amount?.currencyCode || result.amount.value === undefined) {
      throw new GatewayError(GATEWAY_ID, `Refund ${result.id} is missing its amount or currency`);
    }

    return {
      gateway: GATEWAY_ID,
      refundId: result.id,
      amount: Number(result.amount.value),
      currency: result.amount.currencyCode,
      status:
        result.status === RefundStatus.Completed
          ? 'succeeded'
          : result.status === RefundStatus.Failed
            ? 'failed'
            : 'pending',
    };
  }

  async verifyWebhook(request: WebhookRequest): Promise<WebhookEvent> {
    // Checked before the token exchange: a missing webhookId is a configuration
    // mistake, and spending a network round-trip to discover it would both waste the
    // call and report the wrong error.
    if (!this.options.webhookId) {
      throw new ConfigurationError(GATEWAY_ID, 'webhookId is required to verify webhooks');
    }

    // The SDK exposes no webhooks controller, so this borrows a token for the one
    // call it cannot make.
    // Fetched outside the retry: a 401 from the token endpoint means the credentials
    // themselves are rejected, and asking for another token would fail identically.
    const token = await this.accessToken();

    try {
      return await verifyPaypalWebhook(this.options, request, token);
    } catch (error) {
      // A cached token can be revoked before it expires, or the credentials behind it
      // rotated. Without this, verification keeps failing until the cached expiry
      // passes. Retried once only, so genuinely bad credentials still fail fast.
      if (!this.isUnauthorized(error)) throw error;

      this.cachedToken = undefined;
      return verifyPaypalWebhook(this.options, request, await this.accessToken());
    }
  }

  /** A 401 means the token was rejected, not that the signature was bad. */
  protected isUnauthorized(error: unknown): boolean {
    return error instanceof GatewayError && error.status === 401;
  }

  /**
   * Obtain a client-credentials token for the calls the SDK does not cover.
   *
   * Cached until shortly before it expires. Without this every webhook verification
   * costs two round-trips, which under a burst is both latency and avoidable pressure
   * on PayPal's rate limits. The in-flight promise is shared too, so concurrent
   * verifications do not each start their own exchange.
   */
  protected async accessToken(): Promise<string> {
    const now = Date.now();

    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return this.cachedToken.value;
    }

    this.tokenRequest ??= this.requestAccessToken().finally(() => {
      this.tokenRequest = undefined;
    });

    return this.tokenRequest;
  }

  private async requestAccessToken(): Promise<string> {
    const credentials = Buffer.from(
      `${this.options.clientId}:${this.options.clientSecret}`,
    ).toString('base64');

    const response = await fetch(`${paypalApiBase(this.options.environment)}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new GatewayError(GATEWAY_ID, 'could not obtain an access token', response.status);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new GatewayError(GATEWAY_ID, 'token response contained no access_token');
    }

    // A 60-second margin, so a token cannot expire between this check and its use.
    const lifetime = Math.max((body.expires_in ?? 0) - TOKEN_EXPIRY_MARGIN_SECONDS, 0);
    this.cachedToken = { value: body.access_token, expiresAt: Date.now() + lifetime * 1000 };

    return body.access_token;
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
      this.rethrow(error);
    }
  }

  /**
   * Rethrow a provider error as the PaymentError family, passing anything else through.
   *
   * Returns `never` so call sites read as terminal and the compiler knows control does
   * not continue past them.
   */
  protected rethrow(error: unknown): never {
    if (error instanceof ApiError) {
      // `error.message` is safe. The response body echoes the request back and is dropped.
      throw new GatewayError(GATEWAY_ID, error.message, error.statusCode);
    }
    throw error;
  }
}

export function createPaypalGateway(options: PaypalOptions): PaypalGateway {
  return new PaypalGateway(options);
}

export type { PaypalGateway };
