import nock from 'nock';
import { GatewayError } from '../../../src/errors';
import { createPaypalGateway } from '../../../src/gateways/paypal/paypal.gateway';

const API = 'https://api-m.sandbox.paypal.com';

function gateway() {
  return createPaypalGateway({
    clientId: 'id',
    clientSecret: 'secret',
    environment: 'sandbox',
  });
}

function mockToken(): void {
  nock(API)
    .post('/v1/oauth2/token')
    .reply(200, { access_token: 'tok_1', token_type: 'Bearer', expires_in: 32400 });
}

beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
});

afterEach(() => {
  nock.enableNetConnect();
});

const request = {
  reference: 'ref-1',
  amount: 49.9,
  currency: 'USD',
  successUrl: 'https://example.com/s',
  cancelUrl: 'https://example.com/c',
};

describe('paypal checkout', () => {
  it('returns the payer-action approval url', async () => {
    mockToken();
    nock(API)
      .post('/v2/checkout/orders')
      .reply(201, {
        id: 'ORDER-1',
        status: 'PAYER_ACTION_REQUIRED',
        links: [
          { rel: 'self', href: `${API}/v2/checkout/orders/ORDER-1` },
          { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1' },
        ],
      });

    expect(await gateway().checkout(request)).toEqual({
      status: 'redirect',
      gateway: 'paypal',
      sessionId: 'ORDER-1',
      url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
    });
  });

  it('formats the amount as a decimal string, not minor units', async () => {
    mockToken();
    let sent: unknown;
    nock(API)
      .post('/v2/checkout/orders', (body: unknown) => {
        sent = body;
        return true;
      })
      .reply(201, { id: 'ORDER-1', links: [{ rel: 'payer-action', href: 'https://x' }] });

    await gateway().checkout(request);

    const body = sent as {
      intent: string;
      purchase_units: [{ amount: { value: string; currency_code: string }; reference_id: string }];
    };
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0].amount.value).toBe('49.90');
    expect(body.purchase_units[0].amount.currency_code).toBe('USD');
    expect(body.purchase_units[0].reference_id).toBe('ref-1');
  });

  it('rejects a currency PayPal does not settle before calling out', async () => {
    // No token mock is registered, so any network attempt would fail differently.
    // The error naming the currency is what proves validation ran first.
    await expect(gateway().checkout({ ...request, currency: 'EGP' })).rejects.toThrow(/EGP/);
    await expect(gateway().checkout({ ...request, currency: 'EGP' })).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  it('fails when the response carries no payer-action link', async () => {
    mockToken();
    nock(API)
      .post('/v2/checkout/orders')
      .reply(201, { id: 'ORDER-1', links: [{ rel: 'self', href: 'https://x' }] });

    await expect(gateway().checkout(request)).rejects.toBeInstanceOf(GatewayError);
  });

  it('wraps a PayPal rejection in GatewayError', async () => {
    mockToken();
    nock(API).post('/v2/checkout/orders').reply(422, { name: 'UNPROCESSABLE_ENTITY' });

    await expect(gateway().checkout(request)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('paypal capture', () => {
  it('reports a completed capture as paid', async () => {
    mockToken();
    nock(API)
      .post('/v2/checkout/orders/ORDER-1/capture')
      .reply(201, {
        id: 'ORDER-1',
        status: 'COMPLETED',
        purchase_units: [
          {
            reference_id: 'ref-1',
            payments: {
              captures: [
                {
                  id: 'CAPTURE-1',
                  status: 'COMPLETED',
                  amount: { value: '49.90', currency_code: 'USD' },
                },
              ],
            },
          },
        ],
      });

    expect(await gateway().capture({ sessionId: 'ORDER-1' })).toEqual({
      status: 'paid',
      gateway: 'paypal',
      sessionId: 'ORDER-1',
      transactionId: 'CAPTURE-1',
      amount: 49.9,
      currency: 'USD',
      reference: 'ref-1',
    });
  });

  it('reports a non-completed order as pending', async () => {
    mockToken();
    nock(API)
      .post('/v2/checkout/orders/ORDER-1/capture')
      .reply(201, { id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED' });

    expect(await gateway().capture({ sessionId: 'ORDER-1' })).toEqual({
      status: 'pending',
      gateway: 'paypal',
      sessionId: 'ORDER-1',
    });
  });
});

describe('paypal refund', () => {
  it('refunds a captured payment in full', async () => {
    mockToken();
    nock(API)
      .post('/v2/payments/captures/CAPTURE-1/refund')
      .reply(201, {
        id: 'REFUND-1',
        status: 'COMPLETED',
        amount: { value: '49.90', currency_code: 'USD' },
      });

    expect(await gateway().refund({ transactionId: 'CAPTURE-1', currency: 'USD' })).toEqual({
      gateway: 'paypal',
      refundId: 'REFUND-1',
      amount: 49.9,
      currency: 'USD',
      status: 'succeeded',
    });
  });

  it('sends a partial amount as a decimal string', async () => {
    mockToken();
    let sent: unknown;
    nock(API)
      .post('/v2/payments/captures/CAPTURE-1/refund', (body: unknown) => {
        sent = body;
        return true;
      })
      .reply(201, {
        id: 'REFUND-1',
        status: 'COMPLETED',
        amount: { value: '5.00', currency_code: 'USD' },
      });

    await gateway().refund({ transactionId: 'CAPTURE-1', currency: 'USD', amount: 5 });

    expect((sent as { amount: { value: string } }).amount.value).toBe('5.00');
  });
});

describe('paypal capture idempotency', () => {
  const completedOrder = {
    id: 'ORDER-1',
    status: 'COMPLETED',
    purchase_units: [
      {
        reference_id: 'ref-1',
        payments: {
          captures: [
            {
              id: 'CAPTURE-1',
              status: 'COMPLETED',
              amount: { value: '49.90', currency_code: 'USD' },
            },
          ],
        },
      },
    ],
  };

  // Stripe's capture is a repeatable status read; PayPal's moves money and rejects a
  // second call. Without the read-back the same call would mean two different things.
  it('reads back the existing capture when the order was already captured', async () => {
    mockToken();
    nock(API)
      .post('/v2/checkout/orders/ORDER-1/capture')
      .reply(422, {
        name: 'UNPROCESSABLE_ENTITY',
        details: [{ issue: 'ORDER_ALREADY_CAPTURED' }],
      });
    nock(API).get('/v2/checkout/orders/ORDER-1').reply(200, completedOrder);

    expect(await gateway().capture({ sessionId: 'ORDER-1' })).toEqual({
      status: 'paid',
      gateway: 'paypal',
      sessionId: 'ORDER-1',
      transactionId: 'CAPTURE-1',
      amount: 49.9,
      currency: 'USD',
      reference: 'ref-1',
    });
  });

  it('does not swallow other 422s as already-captured', async () => {
    mockToken();
    nock(API)
      .post('/v2/checkout/orders/ORDER-1/capture')
      .reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });

    await expect(gateway().capture({ sessionId: 'ORDER-1' })).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('paypal missing-field failures', () => {
  it('fails when a captured order carries no capture id', async () => {
    mockToken();
    nock(API)
      .post('/v2/checkout/orders/ORDER-1/capture')
      .reply(201, {
        id: 'ORDER-1',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [{ status: 'COMPLETED', amount: { value: '1.00', currency_code: 'USD' } }],
            },
          },
        ],
      });

    await expect(gateway().capture({ sessionId: 'ORDER-1' })).rejects.toThrow(/no capture id/);
  });

  it('fails when a capture carries no currency rather than assuming USD', async () => {
    mockToken();
    nock(API)
      .post('/v2/checkout/orders/ORDER-1/capture')
      .reply(201, {
        id: 'ORDER-1',
        status: 'COMPLETED',
        purchase_units: [{ payments: { captures: [{ id: 'CAPTURE-1', status: 'COMPLETED' }] } }],
      });

    await expect(gateway().capture({ sessionId: 'ORDER-1' })).rejects.toThrow(/amount or currency/);
  });

  it('fails when checkout returns an order with no id', async () => {
    mockToken();
    nock(API)
      .post('/v2/checkout/orders')
      .reply(201, { links: [{ rel: 'payer-action', href: 'https://x' }] });

    await expect(gateway().checkout(request)).rejects.toThrow(/no id/);
  });
});
