import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Capability } from './capabilities';
import { isCheckoutCapable, isRefundCapable, isWebhookCapable } from './capabilities';
import { UnknownGatewayError, UnsupportedOperationError } from './errors';
import type { PaymentGateway } from './gateway.interface';
import { PAYMENT_MODULE_OPTIONS } from './payment.constants';
import type { PaymentModuleOptions } from './payment.module-options';
import type { PaymentEventPublisher } from './publisher';
import { NoopPublisher, safePublish } from './publisher';
import type {
  CaptureRequest,
  CaptureResult,
  CheckoutRequest,
  CheckoutResult,
  PaymentEvent,
  RefundRequest,
  RefundResult,
  WebhookEvent,
  WebhookRequest,
} from './types';

/**
 * The one thing applications inject.
 *
 * Every method takes a gateway id first, so switching provider is a configuration
 * change rather than a code change:
 *
 *     await payments.checkout('stripe', request);
 *     await payments.checkout(tenant.gateway, request);
 */
@Injectable()
export class PaymentService {
  private readonly gateways = new Map<string, PaymentGateway>();

  private readonly publisher: PaymentEventPublisher;

  constructor(
    @Inject(PAYMENT_MODULE_OPTIONS)
    @Optional()
    private readonly options: PaymentModuleOptions = { gateways: [] },
  ) {
    for (const gateway of options.gateways) {
      this.gateways.set(gateway.id, gateway);
    }
    this.publisher = options.publisher ?? new NoopPublisher();
  }

  /** Ids of every registered gateway, in registration order. */
  get registered(): string[] {
    return [...this.gateways.keys()];
  }

  /** Whether a gateway both declares and implements a capability. */
  supports(gatewayId: string, capability: Capability): boolean {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) return false;

    if (capability === 'checkout') return isCheckoutCapable(gateway);
    if (capability === 'refund') return isRefundCapable(gateway);
    return isWebhookCapable(gateway);
  }

  /** Escape hatch for provider-specific work the shared vocabulary does not cover. */
  gateway(gatewayId: string): PaymentGateway {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) throw new UnknownGatewayError(gatewayId, this.registered);
    return gateway;
  }

  async checkout(gatewayId: string, request: CheckoutRequest): Promise<CheckoutResult> {
    const gateway = this.gateway(gatewayId);
    if (!isCheckoutCapable(gateway)) {
      throw new UnsupportedOperationError(gatewayId, 'checkout');
    }

    try {
      const result = await gateway.checkout(request);
      await this.emit({
        name: 'checkout.created',
        gateway: gatewayId,
        reference: request.reference,
        sessionId: result.sessionId,
      });
      return result;
    } catch (error) {
      await this.emit({
        name: 'checkout.failed',
        gateway: gatewayId,
        reference: request.reference,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      throw error;
    }
  }

  async capture(gatewayId: string, request: CaptureRequest): Promise<CaptureResult> {
    const gateway = this.gateway(gatewayId);
    if (!isCheckoutCapable(gateway)) {
      throw new UnsupportedOperationError(gatewayId, 'capture');
    }

    const result = await gateway.capture(request);

    await this.emit(
      result.status === 'paid'
        ? {
            name: 'payment.captured',
            gateway: gatewayId,
            sessionId: result.sessionId,
            transactionId: result.transactionId,
          }
        : {
            name: 'payment.failed',
            gateway: gatewayId,
            sessionId: request.sessionId,
            reason: result.status,
          },
    );

    return result;
  }

  async refund(gatewayId: string, request: RefundRequest): Promise<RefundResult> {
    const gateway = this.gateway(gatewayId);
    if (!isRefundCapable(gateway)) {
      throw new UnsupportedOperationError(gatewayId, 'refund');
    }

    const result = await gateway.refund(request);
    await this.emit({ name: 'refund.created', gateway: gatewayId, refundId: result.refundId });
    return result;
  }

  async verifyWebhook(gatewayId: string, request: WebhookRequest): Promise<WebhookEvent> {
    const gateway = this.gateway(gatewayId);
    if (!isWebhookCapable(gateway)) {
      throw new UnsupportedOperationError(gatewayId, 'verifyWebhook');
    }

    try {
      const event = await gateway.verifyWebhook(request);
      await this.emit({
        name: 'webhook.verified',
        gateway: gatewayId,
        type: event.type,
        id: event.id,
      });
      return event;
    } catch (error) {
      await this.emit({
        name: 'webhook.rejected',
        gateway: gatewayId,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
      throw error;
    }
  }

  private emit(event: PaymentEvent): Promise<void> {
    return safePublish(this.publisher, event, this.options.onPublishError);
  }
}
