import type { Capability } from '../../src/capabilities';
import { UnknownGatewayError, UnsupportedOperationError } from '../../src/errors';
import type { PaymentGateway } from '../../src/gateway.interface';
import { PaymentService } from '../../src/payment.service';

function fakeGateway(
  id: string,
  capabilities: Capability[],
  methods: Record<string, unknown> = {},
): PaymentGateway {
  return {
    id,
    currencies: null,
    capabilities: new Set<Capability>(capabilities),
    ...methods,
  };
}

const request = {
  reference: 'r',
  amount: 1,
  currency: 'USD',
  successUrl: 'https://x/s',
  cancelUrl: 'https://x/c',
};

const redirect = {
  status: 'redirect' as const,
  gateway: 'stripe',
  sessionId: 'cs_1',
  url: 'https://x',
};

function checkoutGateway(id = 'stripe') {
  return fakeGateway(id, ['checkout'], {
    checkout: jest.fn().mockResolvedValue(redirect),
    capture: jest.fn(),
  });
}

describe('PaymentService dispatch', () => {
  it('lists registered gateways in registration order', () => {
    const service = new PaymentService({
      gateways: [fakeGateway('stripe', []), fakeGateway('paypal', [])],
    });
    expect(service.registered).toEqual(['stripe', 'paypal']);
  });

  it('throws UnknownGatewayError naming the alternatives', () => {
    const service = new PaymentService({ gateways: [fakeGateway('stripe', [])] });
    expect(() => service.gateway('adyen')).toThrow(UnknownGatewayError);
  });

  it('throws UnsupportedOperationError before touching the provider', async () => {
    const service = new PaymentService({ gateways: [fakeGateway('paypal', [])] });
    await expect(service.checkout('paypal', request)).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
  });

  it('routes to the named gateway', async () => {
    const stripe = checkoutGateway('stripe');
    const paypal = checkoutGateway('paypal');
    const service = new PaymentService({ gateways: [stripe, paypal] });

    await service.checkout('stripe', request);

    expect((stripe as unknown as { checkout: jest.Mock }).checkout).toHaveBeenCalledTimes(1);
    expect((paypal as unknown as { checkout: jest.Mock }).checkout).not.toHaveBeenCalled();
  });

  it('publishes an event on success', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const service = new PaymentService({ gateways: [checkoutGateway()], publisher: { publish } });

    await service.checkout('stripe', request);

    expect(publish).toHaveBeenCalledWith({
      name: 'checkout.created',
      gateway: 'stripe',
      reference: 'r',
      sessionId: 'cs_1',
    });
  });

  it('publishes a failure event and rethrows when the gateway fails', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const service = new PaymentService({
      gateways: [
        fakeGateway('stripe', ['checkout'], {
          checkout: jest.fn().mockRejectedValue(new Error('declined')),
          capture: jest.fn(),
        }),
      ],
      publisher: { publish },
    });

    await expect(service.checkout('stripe', request)).rejects.toThrow('declined');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'checkout.failed', error: 'declined' }),
    );
  });

  // A broker outage must not fail a payment that already succeeded.
  it('does not fail the payment when the publisher throws', async () => {
    const service = new PaymentService({
      gateways: [checkoutGateway()],
      publisher: { publish: jest.fn().mockRejectedValue(new Error('broker down')) },
    });

    await expect(service.checkout('stripe', request)).resolves.toMatchObject({
      sessionId: 'cs_1',
    });
  });

  it('emits payment.captured for a paid capture', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const service = new PaymentService({
      gateways: [
        fakeGateway('stripe', ['checkout'], {
          checkout: jest.fn(),
          capture: jest.fn().mockResolvedValue({
            status: 'paid',
            gateway: 'stripe',
            sessionId: 'cs_1',
            transactionId: 'pi_1',
            amount: 10,
            currency: 'USD',
          }),
        }),
      ],
      publisher: { publish },
    });

    await service.capture('stripe', { sessionId: 'cs_1' });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'payment.captured', transactionId: 'pi_1' }),
    );
  });

  it('reports capability support', () => {
    const service = new PaymentService({ gateways: [checkoutGateway()] });

    expect(service.supports('stripe', 'checkout')).toBe(true);
    expect(service.supports('stripe', 'refund')).toBe(false);
    expect(service.supports('nope', 'checkout')).toBe(false);
  });

  it('defaults to no gateways when constructed without options', () => {
    expect(new PaymentService().registered).toEqual([]);
  });
});

describe('PaymentService refund dispatch', () => {
  const refundResult = {
    gateway: 'stripe',
    refundId: 're_1',
    amount: 5,
    currency: 'USD',
    status: 'succeeded' as const,
  };

  function refundGateway() {
    return fakeGateway('stripe', ['refund'], {
      refund: jest.fn().mockResolvedValue(refundResult),
    });
  }

  it('rejects a gateway that cannot refund', async () => {
    const service = new PaymentService({ gateways: [fakeGateway('paypal', [])] });

    await expect(
      service.refund('paypal', { transactionId: 't', currency: 'USD' }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it('returns the refund and emits refund.created', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const service = new PaymentService({ gateways: [refundGateway()], publisher: { publish } });

    await expect(
      service.refund('stripe', { transactionId: 't', currency: 'USD' }),
    ).resolves.toEqual(refundResult);
    expect(publish).toHaveBeenCalledWith({
      name: 'refund.created',
      gateway: 'stripe',
      refundId: 're_1',
    });
  });
});

describe('PaymentService webhook dispatch', () => {
  const event = {
    gateway: 'stripe',
    type: 'checkout.session.completed',
    id: 'evt_1',
    payload: {},
  };

  it('rejects a gateway that cannot verify webhooks', async () => {
    const service = new PaymentService({ gateways: [fakeGateway('paypal', [])] });

    await expect(
      service.verifyWebhook('paypal', { rawBody: '{}', headers: {} }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it('returns the event and emits webhook.verified', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const service = new PaymentService({
      gateways: [
        fakeGateway('stripe', ['webhooks'], {
          verifyWebhook: jest.fn().mockResolvedValue(event),
        }),
      ],
      publisher: { publish },
    });

    await expect(service.verifyWebhook('stripe', { rawBody: '{}', headers: {} })).resolves.toEqual(
      event,
    );
    expect(publish).toHaveBeenCalledWith({
      name: 'webhook.verified',
      gateway: 'stripe',
      type: 'checkout.session.completed',
      id: 'evt_1',
    });
  });

  it('emits webhook.rejected and rethrows when verification fails', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const service = new PaymentService({
      gateways: [
        fakeGateway('stripe', ['webhooks'], {
          verifyWebhook: jest.fn().mockRejectedValue(new Error('bad signature')),
        }),
      ],
      publisher: { publish },
    });

    await expect(service.verifyWebhook('stripe', { rawBody: '{}', headers: {} })).rejects.toThrow(
      'bad signature',
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'webhook.rejected', reason: 'bad signature' }),
    );
  });

  it('emits payment.failed for a capture that did not settle', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const service = new PaymentService({
      gateways: [
        fakeGateway('stripe', ['checkout'], {
          checkout: jest.fn(),
          capture: jest
            .fn()
            .mockResolvedValue({ status: 'pending', gateway: 'stripe', sessionId: 'cs_1' }),
        }),
      ],
      publisher: { publish },
    });

    await service.capture('stripe', { sessionId: 'cs_1' });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'payment.failed', reason: 'pending' }),
    );
  });

  it('reports a non-Error rejection without crashing', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const service = new PaymentService({
      gateways: [
        fakeGateway('stripe', ['checkout'], {
          checkout: jest.fn().mockRejectedValue('a bare string'),
          capture: jest.fn(),
        }),
      ],
      publisher: { publish },
    });

    await expect(service.checkout('stripe', request)).rejects.toBe('a bare string');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'checkout.failed', error: 'unknown error' }),
    );
  });
});
