import { GatewayError } from '../../../src/errors';
import { createStripeGateway } from '../../../src/gateways/stripe/stripe.gateway';
import { FakeStripeHttp } from '../../support/stripe-fake';

function gateway(fake: FakeStripeHttp, apiKey = 'sk_test_A') {
  return createStripeGateway({ apiKey, httpClient: fake.build() });
}

const request = {
  reference: 'ref-1',
  amount: 19.99,
  currency: 'USD',
  successUrl: 'https://example.com/s',
  cancelUrl: 'https://example.com/c',
  description: 'Pro plan',
};

function sessionStub(fake: FakeStripeHttp): FakeStripeHttp {
  return fake.stub('/v1/checkout/sessions', {
    id: 'cs_1',
    object: 'checkout.session',
    url: 'https://checkout.stripe.com/pay/cs_1',
  });
}

describe('stripe checkout', () => {
  it('returns a redirect result', async () => {
    const fake = sessionStub(new FakeStripeHttp());

    expect(await gateway(fake).checkout(request)).toEqual({
      status: 'redirect',
      gateway: 'stripe',
      sessionId: 'cs_1',
      url: 'https://checkout.stripe.com/pay/cs_1',
    });
  });

  it('sends the amount in minor units', async () => {
    const fake = sessionStub(new FakeStripeHttp());

    await gateway(fake).checkout(request);

    // Regression: 19.99 * 100 is 1998.9999999999998 and truncates to 1998.
    expect(fake.lastBody()['line_items[0][price_data][unit_amount]']).toBe('1999');
  });

  it('sends its own credentials', async () => {
    const fake = sessionStub(new FakeStripeHttp());

    await gateway(fake, 'sk_test_TENANT').checkout(request);

    expect(fake.lastBearerToken()).toBe('sk_test_TENANT');
  });

  it('appends the session id placeholder to the success url', async () => {
    const fake = sessionStub(new FakeStripeHttp());

    await gateway(fake).checkout(request);

    // Stripe substitutes this server-side; without it the app cannot resolve the session.
    expect(fake.lastBody()['success_url']).toBe(
      'https://example.com/s?session_id={CHECKOUT_SESSION_ID}',
    );
  });

  it('carries the reference into metadata and client_reference_id', async () => {
    const fake = sessionStub(new FakeStripeHttp());

    await gateway(fake).checkout(request);

    expect(fake.lastBody()['client_reference_id']).toBe('ref-1');
    expect(fake.lastBody()['metadata[reference]']).toBe('ref-1');
  });

  it('rejects a currency it does not support before calling Stripe', async () => {
    const fake = new FakeStripeHttp();

    await expect(gateway(fake).checkout({ ...request, currency: 'XXX' })).rejects.toBeInstanceOf(
      GatewayError,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it('wraps a Stripe rejection in GatewayError', async () => {
    const fake = new FakeStripeHttp().stub(
      '/v1/checkout/sessions',
      { error: { type: 'invalid_request_error', message: 'Amount must be positive' } },
      400,
    );

    await expect(gateway(fake).checkout(request)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('stripe capture', () => {
  it('reports a paid session', async () => {
    const fake = new FakeStripeHttp().stub('/v1/checkout/sessions/cs_1', {
      id: 'cs_1',
      object: 'checkout.session',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      client_reference_id: 'ref-1',
      amount_total: 1999,
      currency: 'usd',
    });

    expect(await gateway(fake).capture({ sessionId: 'cs_1' })).toEqual({
      status: 'paid',
      gateway: 'stripe',
      sessionId: 'cs_1',
      transactionId: 'pi_1',
      amount: 19.99,
      currency: 'USD',
      reference: 'ref-1',
    });
  });

  it('reports an unpaid session as pending', async () => {
    const fake = new FakeStripeHttp().stub('/v1/checkout/sessions/cs_1', {
      id: 'cs_1',
      object: 'checkout.session',
      payment_status: 'unpaid',
    });

    expect(await gateway(fake).capture({ sessionId: 'cs_1' })).toEqual({
      status: 'pending',
      gateway: 'stripe',
      sessionId: 'cs_1',
    });
  });
});
