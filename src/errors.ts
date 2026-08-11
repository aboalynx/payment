/**
 * One error family, so a caller can `catch (e) { if (e instanceof PaymentError) ... }`
 * without knowing which provider failed.
 *
 * Messages carry the HTTP status but never the provider's response body — those echo
 * billing data back and must not reach a log or a bug report.
 */
export abstract class PaymentError extends Error {
  protected constructor(
    readonly gatewayId: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The requested gateway id was never registered. */
export class UnknownGatewayError extends PaymentError {
  constructor(gatewayId: string, available: string[]) {
    super(gatewayId, `Unknown payment gateway '${gatewayId}'. Registered: ${available.join(', ')}`);
  }
}

/** The gateway exists but does not declare the capability this operation needs. */
export class UnsupportedOperationError extends PaymentError {
  constructor(
    gatewayId: string,
    readonly operation: string,
  ) {
    super(gatewayId, `Gateway '${gatewayId}' does not support '${operation}'`);
  }
}

/** The provider rejected the request. */
export class GatewayError extends PaymentError {
  constructor(
    gatewayId: string,
    message: string,
    readonly status?: number,
  ) {
    super(gatewayId, status === undefined ? message : `${message} (HTTP ${status})`);
  }
}

/** A webhook payload failed signature verification. */
export class WebhookVerificationError extends PaymentError {
  constructor(gatewayId: string, reason: string) {
    super(gatewayId, `Webhook verification failed for '${gatewayId}': ${reason}`);
  }
}

/** The gateway was constructed without something it requires. */
export class ConfigurationError extends PaymentError {
  constructor(gatewayId: string, message: string) {
    super(gatewayId, `Misconfigured gateway '${gatewayId}': ${message}`);
  }
}
