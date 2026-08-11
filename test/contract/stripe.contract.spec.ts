import { createStripeGateway } from '../../src/gateways/stripe/stripe.gateway';
import { FakeStripeHttp } from '../support/stripe-fake';
import { describeGatewayContract } from './gateway-contract';

describeGatewayContract('stripe', () =>
  createStripeGateway({ apiKey: 'sk_test', webhookSecret: 'whsec_test' }),
);

describe('stripe credential isolation', () => {
  // Two gateways for different tenants must not share credentials. In the PHP
  // predecessor this failed because the SDK held the key in a process-global; the Node
  // SDK is instance-based, and this test is what keeps it that way.
  it('sends its own key even after another gateway is constructed', async () => {
    const fake = new FakeStripeHttp().stub('/v1/checkout/sessions', {
      id: 'cs_a',
      object: 'checkout.session',
      url: 'https://a',
    });

    const tenantA = createStripeGateway({ apiKey: 'sk_tenant_A', httpClient: fake.build() });
    createStripeGateway({ apiKey: 'sk_tenant_B' });

    await tenantA.checkout({
      reference: 'r',
      amount: 10,
      currency: 'USD',
      successUrl: 'https://x/s',
      cancelUrl: 'https://x/c',
    });

    expect(fake.lastBearerToken()).toBe('sk_tenant_A');
  });
});
