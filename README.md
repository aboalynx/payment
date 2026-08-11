# @aboalynx/payment

Gateway-agnostic payment processing for NestJS. One interface for Stripe and PayPal, designed to be extended.

[![npm](https://img.shields.io/npm/v/@aboalynx/payment)](https://www.npmjs.com/package/@aboalynx/payment)
[![CI](https://github.com/aboalynx/payment/actions/workflows/ci.yml/badge.svg)](https://github.com/aboalynx/payment/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![NestJS](https://img.shields.io/badge/nestjs-10%20%7C%2011-e0234e.svg)](package.json)

---

## Why

Payment integrations tend to grow one service class per provider, each shaped by that
provider's API. This package puts one vocabulary in front of them:

```ts
await payments.checkout('stripe', request);
await payments.checkout('paypal', request); // same request, same result shape
await payments.checkout(tenant.gateway, request); // provider is now configuration
```

Adding a provider means implementing the capability interfaces it supports and passing a
shared contract suite. Calling code does not change.

## Install

Published from CI with [build provenance](https://www.npmjs.com/package/@aboalynx/payment) —
the tarball is cryptographically tied to the commit and workflow that built it.

```bash
npm install @aboalynx/payment
```

`@nestjs/common` and `@nestjs/core` are peer dependencies.

## Quick start

```ts
import { Module } from '@nestjs/common';
import { PaymentModule, createStripeGateway, createPaypalGateway } from '@aboalynx/payment';

@Module({
  imports: [
    PaymentModule.forRoot({
      gateways: [
        createStripeGateway({
          apiKey: process.env.STRIPE_SECRET_KEY!,
          webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
        }),
        createPaypalGateway({
          clientId: process.env.PAYPAL_CLIENT_ID!,
          clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
          environment: 'sandbox',
          webhookId: process.env.PAYPAL_WEBHOOK_ID,
        }),
      ],
    }),
  ],
})
export class AppModule {}
```

With credentials from `ConfigService`:

```ts
PaymentModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    gateways: [createStripeGateway({ apiKey: config.getOrThrow('STRIPE_SECRET_KEY') })],
  }),
});
```

## Taking a payment

```ts
@Injectable()
export class CheckoutService {
  constructor(private readonly payments: PaymentService) {}

  async start(order: Order): Promise<string> {
    const result = await this.payments.checkout('stripe', {
      reference: order.id,
      amount: 49.99, // major units — conversion happens inside the gateway
      currency: 'USD',
      description: 'Pro plan',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    // Persist result.sessionId — you need it to capture.
    await this.orders.recordSession(order.id, result.sessionId);

    return result.status === 'redirect' ? result.url : result.code;
  }

  async finish(sessionId: string) {
    const result = await this.payments.capture('stripe', { sessionId });

    if (result.status === 'paid') {
      // result.transactionId is what you refund later.
      await this.orders.markPaid(result.reference!, result.transactionId);
    }
  }
}
```

`CheckoutResult` and `CaptureResult` are discriminated unions, so the compiler makes you
handle every outcome.

## Refunds

```ts
await payments.refund('stripe', { transactionId: 'pi_123', currency: 'USD' }); // full
await payments.refund('stripe', { transactionId: 'pi_123', currency: 'USD', amount: 5 }); // partial
```

## Webhooks

The package verifies signatures; your application owns the route. See
[docs/webhooks.md](docs/webhooks.md) for a controller you can copy, the raw-body
requirement, and the idempotency your application is responsible for.

```ts
const event = await payments.verifyWebhook('stripe', {
  rawBody: request.rawBody, // the unparsed bytes — see docs/webhooks.md
  headers: request.headers,
});
```

## Capabilities

A gateway declares what it supports; asking for anything else throws
`UnsupportedOperationError` before any network call.

```ts
if (payments.supports('paypal', 'refund')) {
  await payments.refund('paypal', { transactionId, currency });
}
```

| Capability       | Operations                        | Stripe  |         PayPal          |
| ---------------- | --------------------------------- | :-----: | :---------------------: |
| `checkout`       | `checkout`, `capture`             |   ✅    |           ✅            |
| `refund`         | `refund`                          |   ✅    |           ✅            |
| `webhooks`       | `verifyWebhook`                   |   ✅    |           ✅            |
| `paymentMethods` | setup, retrieve, delete           | planned |         planned         |
| `savedCharge`    | charge a stored method            | planned |         planned         |
| `platform`       | onboarding, OAuth, account status | planned |         planned         |
| `tax`            | tax calculation                   | planned | not supported by PayPal |

### capture() is idempotent on both gateways

Calling `capture()` twice for the same session is safe. That takes work to be true:
Stripe's equivalent is a status read that can be repeated freely, while PayPal's
`captureOrder` moves money and rejects a second call with `ORDER_ALREADY_CAPTURED`. The
PayPal gateway catches exactly that and reads the existing capture back, so the same call
means the same thing regardless of provider.

This matters for webhook handlers, which providers retry. A duplicate delivery that
reaches `capture()` will not double-charge or throw.

## Money

Amounts cross the public API in **major units** — `49.99`, not `4999`. Each gateway
converts using the ISO-4217 exponent for the currency: 2 decimals for USD, 3 for KWD,
0 for JPY. Stripe receives minor units; PayPal receives a decimal string. Neither is
your problem.

```ts
import { toMinorUnit } from '@aboalynx/payment';

toMinorUnit(49.99, 'USD'); // 4999
toMinorUnit(49.99, 'KWD'); // 49990
toMinorUnit(4999, 'JPY'); // 4999
```

## Events

Every operation emits a typed event through a publisher you supply. The package depends
on no message broker.

```ts
PaymentModule.forRoot({
  gateways: [...],
  publisher: {
    publish: async (event) => rabbit.publish('payments', event.name, event),
  },
});
```

Publishing never fails a payment — if the broker is down after a charge succeeded, the
charge still succeeded. See [docs/events.md](docs/events.md) for a RabbitMQ example and
the transactional outbox pattern you should use in production.

## What this package does not do

- **No HTTP routes.** Routing is your application's. The package never registers a
  controller.
- **No persistence.** It takes a request, calls a provider, returns a typed result. What
  you store is your decision.
- **No message broker.** Events go through a port you implement.

All three are deliberate: a library that ships them forces its own routing, storage and
infrastructure opinions onto every consumer.

## Extending

Adding a gateway means implementing `PaymentGateway` plus the capability interfaces the
provider supports, then passing the shared contract suite. See
[docs/adding-a-gateway.md](docs/adding-a-gateway.md).

## Documentation

- [Architecture](docs/architecture.md) — the three layers and why the boundaries sit where they do
- [Adding a gateway](docs/adding-a-gateway.md) — the extension guide
- [Webhooks](docs/webhooks.md) — raw bodies, verification, idempotency
- [Events](docs/events.md) — the publisher port, RabbitMQ, the outbox pattern

## Development

```bash
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
