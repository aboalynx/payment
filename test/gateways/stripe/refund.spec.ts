import { createStripeGateway } from '../../../src/gateways/stripe/stripe.gateway';
import { FakeStripeHttp } from '../../support/stripe-fake';

describe('stripe refund', () => {
  it('refunds the full amount when none is given', async () => {
    const fake = new FakeStripeHttp().stub('/v1/refunds', {
      id: 're_1',
      object: 'refund',
      amount: 1999,
      currency: 'usd',
      status: 'succeeded',
    });

    const result = await createStripeGateway({
      apiKey: 'sk_test',
      httpClient: fake.build(),
    }).refund({ transactionId: 'pi_1', currency: 'USD' });

    expect(result).toEqual({
      gateway: 'stripe',
      refundId: 're_1',
      amount: 19.99,
      currency: 'USD',
      status: 'succeeded',
    });
    // Omitting `amount` is what tells Stripe to refund in full.
    expect(fake.lastBody()['amount']).toBeUndefined();
  });

  it('sends a partial amount in minor units', async () => {
    const fake = new FakeStripeHttp().stub('/v1/refunds', {
      id: 're_1',
      object: 'refund',
      amount: 500,
      currency: 'usd',
      status: 'succeeded',
    });

    await createStripeGateway({ apiKey: 'sk_test', httpClient: fake.build() }).refund({
      transactionId: 'pi_1',
      currency: 'USD',
      amount: 5,
    });

    expect(fake.lastBody()['amount']).toBe('500');
    expect(fake.lastBody()['payment_intent']).toBe('pi_1');
  });

  it('maps a pending refund status', async () => {
    const fake = new FakeStripeHttp().stub('/v1/refunds', {
      id: 're_1',
      object: 'refund',
      amount: 1999,
      currency: 'usd',
      status: 'pending',
    });

    const result = await createStripeGateway({
      apiKey: 'sk_test',
      httpClient: fake.build(),
    }).refund({ transactionId: 'pi_1', currency: 'USD' });

    expect(result.status).toBe('pending');
  });
});
