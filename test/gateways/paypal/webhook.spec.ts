import nock from 'nock';
import { ConfigurationError, WebhookVerificationError } from '../../../src/errors';
import { createPaypalGateway } from '../../../src/gateways/paypal/paypal.gateway';

const API = 'https://api-m.sandbox.paypal.com';

const body = JSON.stringify({
  id: 'WH-1',
  event_type: 'CHECKOUT.ORDER.APPROVED',
  resource: { id: 'ORDER-1' },
});

const headers = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig-1',
  'paypal-transmission-time': '2026-08-11T00:00:00Z',
};

function gateway() {
  return createPaypalGateway({
    clientId: 'id',
    clientSecret: 'secret',
    environment: 'sandbox',
    webhookId: 'WEBHOOK-ID',
  });
}

/**
 * Separate helper rather than gateway(undefined): passing undefined to a parameter
 * with a default silently applies the default, so the gateway would still be
 * configured and the test would assert nothing.
 */
function gatewayWithoutWebhookId() {
  return createPaypalGateway({ clientId: 'id', clientSecret: 'secret', environment: 'sandbox' });
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

describe('paypal webhook verification', () => {
  it('returns the event when PayPal confirms the signature', async () => {
    mockToken();
    nock(API)
      .post('/v1/notifications/verify-webhook-signature')
      .reply(200, { verification_status: 'SUCCESS' });

    const event = await gateway().verifyWebhook({ rawBody: body, headers });

    expect(event.gateway).toBe('paypal');
    expect(event.id).toBe('WH-1');
    expect(event.type).toBe('CHECKOUT.ORDER.APPROVED');
    expect(event.sessionId).toBe('ORDER-1');
  });

  it('rejects when PayPal reports failure', async () => {
    mockToken();
    nock(API)
      .post('/v1/notifications/verify-webhook-signature')
      .reply(200, { verification_status: 'FAILURE' });

    await expect(gateway().verifyWebhook({ rawBody: body, headers })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it('sends the webhook id and every transmission header PayPal requires', async () => {
    mockToken();
    let sent: Record<string, unknown> = {};
    nock(API)
      .post('/v1/notifications/verify-webhook-signature', (payload: Record<string, unknown>) => {
        sent = payload;
        return true;
      })
      .reply(200, { verification_status: 'SUCCESS' });

    await gateway().verifyWebhook({ rawBody: body, headers });

    expect(sent['webhook_id']).toBe('WEBHOOK-ID');
    expect(sent['transmission_id']).toBe('tx-1');
    expect(sent['transmission_sig']).toBe('sig-1');
    expect(sent['transmission_time']).toBe('2026-08-11T00:00:00Z');
    expect(sent['auth_algo']).toBe('SHA256withRSA');
    expect(sent['cert_url']).toBe('https://api.sandbox.paypal.com/cert.pem');
    // The event must be forwarded as received, not reshaped by us.
    expect(sent['webhook_event']).toEqual(JSON.parse(body));
  });

  it('accepts a Buffer body', async () => {
    mockToken();
    nock(API)
      .post('/v1/notifications/verify-webhook-signature')
      .reply(200, { verification_status: 'SUCCESS' });

    const event = await gateway().verifyWebhook({ rawBody: Buffer.from(body, 'utf8'), headers });

    expect(event.id).toBe('WH-1');
  });

  it('rejects a payload missing transmission headers', async () => {
    mockToken();

    await expect(gateway().verifyWebhook({ rawBody: body, headers: {} })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it('rejects a body that is not valid JSON', async () => {
    mockToken();

    await expect(gateway().verifyWebhook({ rawBody: 'not-json', headers })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it('fails clearly when no webhookId is configured', async () => {
    mockToken();

    await expect(
      gatewayWithoutWebhookId().verifyWebhook({ rawBody: body, headers }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('paypal token caching', () => {
  const ok = { verification_status: 'SUCCESS' };

  // Without caching every verification costs two round-trips, which under a burst is
  // latency plus avoidable pressure on PayPal's rate limits.
  it('reuses the token across verifications', async () => {
    nock(API)
      .post('/v1/oauth2/token')
      .once() // once() is the assertion: a second exchange would 404 on a stray request
      .reply(200, { access_token: 'tok_1', token_type: 'Bearer', expires_in: 32400 });
    nock(API).post('/v1/notifications/verify-webhook-signature').twice().reply(200, ok);

    const gw = gateway();
    await gw.verifyWebhook({ rawBody: body, headers });
    await gw.verifyWebhook({ rawBody: body, headers });

    expect(nock.isDone()).toBe(true);
  });

  it('coalesces concurrent verifications onto one token exchange', async () => {
    nock(API)
      .post('/v1/oauth2/token')
      .once()
      .reply(200, { access_token: 'tok_1', token_type: 'Bearer', expires_in: 32400 });
    nock(API).post('/v1/notifications/verify-webhook-signature').times(3).reply(200, ok);

    const gw = gateway();
    await Promise.all([
      gw.verifyWebhook({ rawBody: body, headers }),
      gw.verifyWebhook({ rawBody: body, headers }),
      gw.verifyWebhook({ rawBody: body, headers }),
    ]);

    expect(nock.isDone()).toBe(true);
  });

  it('does not cache a token across gateway instances', async () => {
    nock(API)
      .post('/v1/oauth2/token')
      .twice()
      .reply(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 32400 });
    nock(API).post('/v1/notifications/verify-webhook-signature').twice().reply(200, ok);

    await gateway().verifyWebhook({ rawBody: body, headers });
    await gateway().verifyWebhook({ rawBody: body, headers });

    expect(nock.isDone()).toBe(true);
  });

  it('rejects a verified event with no id, which would break idempotency', async () => {
    nock(API)
      .post('/v1/oauth2/token')
      .reply(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 32400 });
    nock(API).post('/v1/notifications/verify-webhook-signature').reply(200, ok);

    await expect(
      gateway().verifyWebhook({
        rawBody: JSON.stringify({ event_type: 'X', resource: { id: 'ORDER-1' } }),
        headers,
      }),
    ).rejects.toThrow(/no id/);
  });
});
