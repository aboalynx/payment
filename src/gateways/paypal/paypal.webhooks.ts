import { ConfigurationError, WebhookVerificationError } from '../../errors';
import type { WebhookEvent, WebhookRequest } from '../../types';
import { paypalApiBase, type PaypalOptions } from './paypal.options';

const GATEWAY_ID = 'paypal';

/** Headers PayPal sends with every webhook. All are required to verify. */
const REQUIRED_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const;

function header(headers: WebhookRequest['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Verify a PayPal webhook.
 *
 * PayPal verifies server-side rather than handing out a signing secret, so this makes a
 * network call — unlike Stripe, which verifies locally with an HMAC. That asymmetry is
 * why the SupportsWebhooks interface is async.
 *
 * This bypasses the SDK because @paypal/paypal-server-sdk ships no webhooks controller.
 */
export async function verifyPaypalWebhook(
  options: PaypalOptions,
  request: WebhookRequest,
  accessToken: string,
): Promise<WebhookEvent> {
  if (!options.webhookId) {
    throw new ConfigurationError(GATEWAY_ID, 'webhookId is required to verify webhooks');
  }

  const missing = REQUIRED_HEADERS.filter((name) => !header(request.headers, name));
  if (missing.length > 0) {
    throw new WebhookVerificationError(GATEWAY_ID, `missing headers: ${missing.join(', ')}`);
  }

  const raw =
    typeof request.rawBody === 'string' ? request.rawBody : request.rawBody.toString('utf8');

  let parsed: { id?: string; event_type?: string; resource?: { id?: string } };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new WebhookVerificationError(GATEWAY_ID, 'body is not valid JSON');
  }

  const response = await fetch(
    `${paypalApiBase(options.environment)}/v1/notifications/verify-webhook-signature`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        auth_algo: header(request.headers, 'paypal-auth-algo'),
        cert_url: header(request.headers, 'paypal-cert-url'),
        transmission_id: header(request.headers, 'paypal-transmission-id'),
        transmission_sig: header(request.headers, 'paypal-transmission-sig'),
        transmission_time: header(request.headers, 'paypal-transmission-time'),
        webhook_id: options.webhookId,
        webhook_event: parsed,
      }),
    },
  );

  if (!response.ok) {
    throw new WebhookVerificationError(
      GATEWAY_ID,
      `verification call failed (HTTP ${response.status})`,
    );
  }

  const outcome = (await response.json()) as { verification_status?: string };
  if (outcome.verification_status !== 'SUCCESS') {
    throw new WebhookVerificationError(GATEWAY_ID, 'PayPal reported the signature as invalid');
  }

  // Applications use `id` to deduplicate retried deliveries. An empty string would
  // make every event look like the same event, so a verified payload without one is a
  // hard failure rather than something to paper over.
  if (!parsed.id) {
    throw new WebhookVerificationError(GATEWAY_ID, 'verified event carries no id');
  }

  if (!parsed.event_type) {
    throw new WebhookVerificationError(GATEWAY_ID, 'verified event carries no event_type');
  }

  return {
    gateway: GATEWAY_ID,
    type: parsed.event_type,
    id: parsed.id,
    ...(parsed.resource?.id ? { sessionId: parsed.resource.id } : {}),
    payload: parsed,
  };
}
