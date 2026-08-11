import { isCheckoutCapable, isRefundCapable, isWebhookCapable } from '../../src/capabilities';
import type { Capability } from '../../src/capabilities';
import type { PaymentGateway } from '../../src/gateway.interface';

function stub(capabilities: Capability[], methods: Record<string, unknown> = {}): PaymentGateway {
  return {
    id: 'stub',
    currencies: null,
    capabilities: new Set<Capability>(capabilities),
    ...methods,
  };
}

describe('capability guards', () => {
  it('accepts a gateway that declares and implements the capability', () => {
    const gateway = stub(['checkout'], { checkout: jest.fn(), capture: jest.fn() });
    expect(isCheckoutCapable(gateway)).toBe(true);
  });

  // Declaring without implementing is the failure mode the contract suite exists to catch.
  it('rejects a gateway that declares a capability but omits a method', () => {
    const gateway = stub(['checkout'], { checkout: jest.fn() });
    expect(isCheckoutCapable(gateway)).toBe(false);
  });

  it('rejects a gateway that implements a method but does not declare it', () => {
    const gateway = stub([], { refund: jest.fn() });
    expect(isRefundCapable(gateway)).toBe(false);
  });

  it('discriminates capabilities independently', () => {
    const gateway = stub(['refund', 'webhooks'], {
      refund: jest.fn(),
      verifyWebhook: jest.fn(),
    });
    expect(isRefundCapable(gateway)).toBe(true);
    expect(isWebhookCapable(gateway)).toBe(true);
    expect(isCheckoutCapable(gateway)).toBe(false);
  });
});
