import { createHmac } from 'node:crypto';
import { ConfigurationError, WebhookVerificationError } from '../../../src/errors';
import { createStripeGateway } from '../../../src/gateways/stripe/stripe.gateway';

const SECRET = 'whsec_test';

function payload(): string {
  return JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', client_reference_id: 'ref-1' } },
  });
}

function signature(
  body: string,
  secret = SECRET,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

function gateway() {
  return createStripeGateway({ apiKey: 'sk_test', webhookSecret: SECRET });
}

describe('stripe webhook verification', () => {
  it('accepts a correctly signed payload', async () => {
    const body = payload();

    const event = await gateway().verifyWebhook({
      rawBody: body,
      headers: { 'stripe-signature': signature(body) },
    });

    expect(event.gateway).toBe('stripe');
    expect(event.id).toBe('evt_1');
    expect(event.type).toBe('checkout.session.completed');
    expect(event.sessionId).toBe('cs_1');
    expect(event.reference).toBe('ref-1');
  });

  it('rejects a forged signature', async () => {
    const body = payload();

    await expect(
      gateway().verifyWebhook({
        rawBody: body,
        headers: { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}` },
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a signature made with a different secret', async () => {
    const body = payload();

    await expect(
      gateway().verifyWebhook({
        rawBody: body,
        headers: { 'stripe-signature': signature(body, 'whsec_attacker') },
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a body modified after signing', async () => {
    const sig = signature(payload());

    await expect(
      gateway().verifyWebhook({
        rawBody: JSON.stringify({ id: 'evt_evil' }),
        headers: { 'stripe-signature': sig },
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a replayed payload outside the tolerance window', async () => {
    const body = payload();
    const stale = Math.floor(Date.now() / 1000) - 86400;

    await expect(
      gateway().verifyWebhook({
        rawBody: body,
        headers: { 'stripe-signature': signature(body, SECRET, stale) },
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a missing signature header', async () => {
    await expect(
      gateway().verifyWebhook({ rawBody: payload(), headers: {} }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('fails clearly when no webhook secret is configured', async () => {
    const body = payload();

    await expect(
      createStripeGateway({ apiKey: 'sk_test' }).verifyWebhook({
        rawBody: body,
        headers: { 'stripe-signature': signature(body) },
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
