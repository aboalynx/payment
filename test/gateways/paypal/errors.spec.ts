import nock from 'nock';
import { ConfigurationError, GatewayError } from '../../../src/errors';
import { createPaypalGateway } from '../../../src/gateways/paypal/paypal.gateway';
import { paypalApiBase } from '../../../src/gateways/paypal/paypal.options';
import { verifyPaypalWebhook } from '../../../src/gateways/paypal/paypal.webhooks';

const SANDBOX = 'https://api-m.sandbox.paypal.com';

const headers = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig-1',
  'paypal-transmission-time': '2026-08-11T00:00:00Z',
};

const body = JSON.stringify({ id: 'WH-1', event_type: 'X', resource: { id: 'ORDER-1' } });

function gateway() {
  return createPaypalGateway({
    clientId: 'id',
    clientSecret: 'secret',
    environment: 'sandbox',
    webhookId: 'WH-ID',
  });
}

beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
});

afterEach(() => {
  nock.enableNetConnect();
});

describe('paypalApiBase', () => {
  it('selects the host from the environment', () => {
    expect(paypalApiBase('sandbox')).toBe(SANDBOX);
    expect(paypalApiBase('production')).toBe('https://api-m.paypal.com');
  });
});

describe('paypal gateway construction', () => {
  it('refuses to construct without a client id', () => {
    expect(() =>
      createPaypalGateway({ clientId: '', clientSecret: 'secret', environment: 'sandbox' }),
    ).toThrow(ConfigurationError);
  });

  it('refuses to construct without a client secret', () => {
    expect(() =>
      createPaypalGateway({ clientId: 'id', clientSecret: '', environment: 'sandbox' }),
    ).toThrow(ConfigurationError);
  });
});

describe('paypal token exchange failures', () => {
  it('reports a rejected token request', async () => {
    nock(SANDBOX).post('/v1/oauth2/token').reply(401, { error: 'invalid_client' });

    await expect(gateway().verifyWebhook({ rawBody: body, headers })).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  it('reports a token response with no access_token', async () => {
    nock(SANDBOX).post('/v1/oauth2/token').reply(200, { token_type: 'Bearer' });

    await expect(gateway().verifyWebhook({ rawBody: body, headers })).rejects.toThrow(
      /access_token/,
    );
  });
});

describe('paypal webhook verification failures', () => {
  it('reports a non-2xx from the verification endpoint', async () => {
    nock(SANDBOX).post('/v1/oauth2/token').reply(200, { access_token: 'tok', expires_in: 32400 });
    nock(SANDBOX).post('/v1/notifications/verify-webhook-signature').reply(500, {});

    // A failed call is a transport problem, not a rejected signature - and only the
    // latter should read as WebhookVerificationError.
    await expect(gateway().verifyWebhook({ rawBody: body, headers })).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  // The helper is exported, so it guards independently of the gateway's own check.
  it('guards the missing webhookId even when called directly', async () => {
    await expect(
      verifyPaypalWebhook(
        { clientId: 'id', clientSecret: 'secret', environment: 'sandbox' },
        { rawBody: body, headers },
        'tok',
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
