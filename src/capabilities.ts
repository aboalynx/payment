import type { PaymentGateway } from './gateway.interface';
import type {
  CaptureRequest,
  CaptureResult,
  CheckoutRequest,
  CheckoutResult,
  RefundRequest,
  RefundResult,
  WebhookEvent,
  WebhookRequest,
} from './types';

/**
 * Operations are grouped rather than piled onto one interface. A gateway implements
 * the groups its provider supports, so "what can this provider do?" is answerable by
 * reading its class declaration.
 *
 * Stage 1 ships three groups. Later stages add SupportsPaymentMethods,
 * SupportsSavedCharge, SupportsPlatform and SupportsTax without editing this file's
 * existing members.
 */
export type Capability = 'checkout' | 'refund' | 'webhooks';

export interface SupportsCheckout extends PaymentGateway {
  checkout(request: CheckoutRequest): Promise<CheckoutResult>;
  capture(request: CaptureRequest): Promise<CaptureResult>;
}

export interface SupportsRefunds extends PaymentGateway {
  refund(request: RefundRequest): Promise<RefundResult>;
}

export interface SupportsWebhooks extends PaymentGateway {
  verifyWebhook(request: WebhookRequest): Promise<WebhookEvent>;
}

/**
 * The guards check the declaration AND the method, because the two can drift: a
 * gateway that declares 'checkout' but forgets `capture` would otherwise fail at call
 * time with a TypeError instead of a clear UnsupportedOperationError.
 */
function has(gateway: PaymentGateway, method: string): boolean {
  return typeof (gateway as unknown as Record<string, unknown>)[method] === 'function';
}

export function isCheckoutCapable(gateway: PaymentGateway): gateway is SupportsCheckout {
  return (
    gateway.capabilities.has('checkout') && has(gateway, 'checkout') && has(gateway, 'capture')
  );
}

export function isRefundCapable(gateway: PaymentGateway): gateway is SupportsRefunds {
  return gateway.capabilities.has('refund') && has(gateway, 'refund');
}

export function isWebhookCapable(gateway: PaymentGateway): gateway is SupportsWebhooks {
  return gateway.capabilities.has('webhooks') && has(gateway, 'verifyWebhook');
}
