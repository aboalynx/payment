import { ConfigurationError, GatewayError } from '../../../src/errors';
import { createStripeGateway } from '../../../src/gateways/stripe/stripe.gateway';
import { FakeStripeHttp } from '../../support/stripe-fake';

const request = {
  reference: 'ref-1',
  amount: 10,
  currency: 'USD',
  successUrl: 'https://example.com/s',
  cancelUrl: 'https://example.com/c',
};

describe('stripe gateway error paths', () => {
  it('refuses to construct without an api key', () => {
    expect(() => createStripeGateway({ apiKey: '' })).toThrow(ConfigurationError);
  });

  // Stripe can return 200 with no url if the session is in an unexpected state. Without
  // this guard the caller would get `undefined` as a redirect target.
  it('fails when Stripe returns a session with no checkout url', async () => {
    const fake = new FakeStripeHttp().stub('/v1/checkout/sessions', {
      id: 'cs_1',
      object: 'checkout.session',
    });

    await expect(
      createStripeGateway({ apiKey: 'sk_test', httpClient: fake.build() }).checkout(request),
    ).rejects.toThrow(/checkout url/);
  });

  it('reports a Stripe authentication failure as a GatewayError with its status', async () => {
    const fake = new FakeStripeHttp().stub(
      '/v1/checkout/sessions',
      { error: { type: 'invalid_request_error', message: 'Invalid API Key' } },
      401,
    );

    await expect(
      createStripeGateway({ apiKey: 'sk_bad', httpClient: fake.build() }).checkout(request),
    ).rejects.toMatchObject({ gatewayId: 'stripe', status: 401 });
  });

  it('does not leak the provider response body into the error message', async () => {
    const fake = new FakeStripeHttp().stub(
      '/v1/checkout/sessions',
      { error: { message: 'Declined' }, card: { number: '4242424242424242' } },
      402,
    );

    await expect(
      createStripeGateway({ apiKey: 'sk_test', httpClient: fake.build() }).checkout(request),
    ).rejects.not.toThrow(/4242424242424242/);
  });

  // The SDK converts transport failures into StripeConnectionError before they reach
  // our wrapper, so a network fault still surfaces as one PaymentError family rather
  // than leaking undici or DNS errors to the caller.
  it('presents a transport failure as a GatewayError', async () => {
    const exploding = {
      getClientName: (): string => 'exploding',
      makeRequest: (): Promise<never> => Promise.reject(new RangeError('socket exploded')),
    };

    await expect(
      createStripeGateway({ apiKey: 'sk_test', httpClient: exploding }).checkout(request),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  it('rejects an unsupported currency with a GatewayError naming it', async () => {
    const fake = new FakeStripeHttp();

    await expect(
      createStripeGateway({ apiKey: 'sk_test', httpClient: fake.build() }).checkout({
        ...request,
        currency: 'XYZ',
      }),
    ).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('stripe capture missing-field failures', () => {
  function paidSessionWithout(missing: Record<string, unknown>) {
    return new FakeStripeHttp().stub('/v1/checkout/sessions/cs_1', {
      id: 'cs_1',
      object: 'checkout.session',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      amount_total: 1999,
      currency: 'usd',
      ...missing,
    });
  }

  function capture(fake: FakeStripeHttp) {
    return createStripeGateway({ apiKey: 'sk_test', httpClient: fake.build() }).capture({
      sessionId: 'cs_1',
    });
  }

  // Returning the session id here would hand the caller a transactionId that refund()
  // cannot use, failing far from the cause.
  it('fails rather than substituting the session id for a missing payment intent', async () => {
    await expect(capture(paidSessionWithout({ payment_intent: null }))).rejects.toThrow(
      /no payment intent/,
    );
  });

  it('fails rather than defaulting a missing currency to USD', async () => {
    await expect(capture(paidSessionWithout({ currency: null }))).rejects.toThrow(/no currency/);
  });

  it('fails rather than treating a missing total as zero', async () => {
    await expect(capture(paidSessionWithout({ amount_total: null }))).rejects.toThrow(/no total/);
  });
});
