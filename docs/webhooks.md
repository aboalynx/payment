# Webhooks

The package verifies signatures. Your application owns the route, and owns idempotency.

---

## The raw body requirement

**This is the single most common way webhook verification fails.**

Signature schemes hash the exact bytes the provider sent. Parsing JSON and
re-serialising it changes key order, whitespace and number formatting, so the hash no
longer matches — even though the data is identical.

Enable raw-body capture in NestJS:

```ts
import { NestFactory } from '@nestjs/core';

const app = await NestFactory.create(AppModule, { rawBody: true });
```

Then pass `request.rawBody`, not `request.body`:

```ts
await payments.verifyWebhook('stripe', {
  rawBody: request.rawBody, // Buffer of the original bytes
  headers: request.headers,
});
```

If verification fails with a valid-looking signature, check this first.

## A controller to copy

The package deliberately ships no controller — routing is yours. This is a complete one
to adapt:

```ts
import { Controller, Headers, HttpCode, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentError, PaymentService } from '@aboalynx/payment';

@Controller('webhooks')
export class PaymentWebhookController {
  constructor(
    private readonly payments: PaymentService,
    private readonly processed: ProcessedEventStore,
    private readonly orders: OrderService,
  ) {}

  @Post(':gateway')
  @HttpCode(200)
  async handle(
    @Param('gateway') gateway: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ): Promise<{ received: true }> {
    let event;

    try {
      event = await this.payments.verifyWebhook(gateway, {
        rawBody: request.rawBody!,
        headers,
      });
    } catch (error) {
      if (error instanceof PaymentError) {
        // Return 400 so the provider knows this was rejected, not lost.
        throw new BadRequestException('signature verification failed');
      }
      throw error;
    }

    // Idempotency: providers retry, so this event may already have been handled.
    if (await this.processed.has(event.id)) {
      return { received: true };
    }

    await this.orders.applyPaymentEvent(event);
    await this.processed.record(event.id);

    return { received: true };
  }
}
```

Return `200` quickly. Do slow work on a queue — providers time out and retry, which
turns a slow handler into duplicate processing.

## Idempotency is your responsibility

Providers deliver **at least once**. The same event will arrive more than once: after a
timeout, after a non-2xx response, and sometimes for no visible reason.

The package gives every verified event a stable `id`. Recording processed ids and
ignoring repeats is the application's job, because the package holds no storage.

```ts
if (await this.processed.has(event.id)) return;
```

Skipping this is how a payment integration double-credits an account. It is worth a
unique index on the event id rather than a check-then-write, so concurrent deliveries
cannot both pass the check.

## How the two providers differ

|                   | Stripe                             | PayPal                         |
| ----------------- | ---------------------------------- | ------------------------------ |
| Verification      | Local HMAC-SHA256                  | Server-side API call           |
| Secret            | `webhookSecret` from the dashboard | `webhookId` from the dashboard |
| Network call      | No                                 | Yes                            |
| Replay protection | Timestamp tolerance, default 300s  | Handled by PayPal              |

Because PayPal verifies over the network, `verifyWebhook` is async for both. It also
means PayPal verification can fail for transient network reasons — treat a failure as
"retry later", not "definitely forged".

### Stripe

Set `webhookSecret` when building the gateway. Tolerance is configurable:

```ts
createStripeGateway({
  apiKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  webhookTolerance: 300,
});
```

### PayPal

Set `webhookId`. PayPal requires five transmission headers; all are checked before the
verification call is made:

```
paypal-auth-algo
paypal-cert-url
paypal-transmission-id
paypal-transmission-sig
paypal-transmission-time
```

A missing header fails with `WebhookVerificationError` and no network call.

## What you get back

```ts
interface WebhookEvent {
  gateway: string;
  type: string; // provider-native, e.g. 'checkout.session.completed'
  id: string; // stable — use this for idempotency
  sessionId?: string;
  reference?: string; // your own reference, when the provider echoes it
  payload: unknown; // the full parsed event
}
```

`type` is deliberately the provider's own event name rather than a normalised one.
Normalising would mean either losing information or inventing a taxonomy that fits
neither provider.
