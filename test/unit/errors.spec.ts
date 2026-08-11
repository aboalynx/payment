import {
  ConfigurationError,
  GatewayError,
  PaymentError,
  UnknownGatewayError,
  UnsupportedOperationError,
  WebhookVerificationError,
} from '../../src/errors';

describe('error hierarchy', () => {
  it('lets a caller catch every payment error as one family', () => {
    const errors = [
      new UnknownGatewayError('nope', ['stripe']),
      new UnsupportedOperationError('paypal', 'tax'),
      new GatewayError('stripe', 'declined', 402),
      new WebhookVerificationError('stripe', 'signature mismatch'),
      new ConfigurationError('stripe', 'apiKey is required'),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(PaymentError);
      expect(error).toBeInstanceOf(Error);
      expect(error.gatewayId).toBeTruthy();
      expect(error.name).toBe(error.constructor.name);
    }
  });

  it('lists the available gateways when one is unknown', () => {
    const error = new UnknownGatewayError('adyen', ['stripe', 'paypal']);
    expect(error.message).toContain('adyen');
    expect(error.message).toContain('stripe, paypal');
  });

  it('names the operation that is unsupported', () => {
    const error = new UnsupportedOperationError('paypal', 'calculateTax');
    expect(error.message).toContain('paypal');
    expect(error.message).toContain('calculateTax');
  });

  it('keeps the http status on a gateway error', () => {
    expect(new GatewayError('stripe', 'boom', 402).status).toBe(402);
  });

  it('omits the status suffix when there is none', () => {
    expect(new GatewayError('stripe', 'boom').message).toBe('boom');
  });

  it('has a stack trace pointing at the throw site', () => {
    expect(new GatewayError('stripe', 'boom').stack).toContain('errors.spec.ts');
  });
});
