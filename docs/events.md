# Events

Every operation emits a typed event. Where those events go is your decision — the
package depends on no message broker.

---

## The port

```ts
interface PaymentEventPublisher {
  publish(event: PaymentEvent): Promise<void>;
}
```

The default is a no-op, so the package works with no infrastructure at all. Supply your
own to route events somewhere:

```ts
PaymentModule.forRoot({
  gateways: [...],
  publisher: myPublisher,
  onPublishError: (error, event) => logger.error({ error, event }, 'publish failed'),
});
```

**Why a port rather than a built-in broker.** Importing `amqplib` would force every
consumer to run RabbitMQ, and rule out Kafka, Redis, SQS, or no broker at all. The same
reasoning that keeps routing and persistence out of this package keeps the broker out.

## The events

```ts
type PaymentEvent =
  | { name: 'checkout.created'; gateway: string; reference: string; sessionId: string }
  | { name: 'checkout.failed'; gateway: string; reference: string; error: string }
  | { name: 'payment.captured'; gateway: string; sessionId: string; transactionId: string }
  | { name: 'payment.failed'; gateway: string; sessionId: string; reason: string }
  | { name: 'refund.created'; gateway: string; refundId: string }
  | { name: 'webhook.verified'; gateway: string; type: string; id: string }
  | { name: 'webhook.rejected'; gateway: string; reason: string };
```

No event carries a credential, a token, or customer PII. If you need the full payment
details, look them up by `sessionId` or `reference` in your own storage.

## Publishing never fails a payment

If the broker is unreachable after a charge has already succeeded, the charge still
succeeded. Reporting an infrastructure failure by throwing would corrupt the caller's
control flow over something that has nothing to do with the payment.

Publish failures are passed to `onPublishError` and otherwise swallowed. That is a
deliberate trade: **you can lose an event this way**, which is why the next section
exists.

## RabbitMQ

Use [`@golevelup/nestjs-rabbitmq`](https://github.com/golevelup/nestjs) rather than
`@nestjs/microservices` — the built-in transport is built around request/response RPC
and makes real topic-exchange routing awkward.

```ts
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import type { PaymentEvent, PaymentEventPublisher } from '@aboalynx/payment';

@Injectable()
export class RabbitPaymentPublisher implements PaymentEventPublisher {
  constructor(private readonly amqp: AmqpConnection) {}

  async publish(event: PaymentEvent): Promise<void> {
    await this.amqp.publish('payments', event.name, event, {
      persistent: true, // survive a broker restart
      messageId: `${event.gateway}:${event.name}:${Date.now()}`,
    });
  }
}
```

Declare the exchange as `topic` so consumers can bind to `payment.*` or
`checkout.failed` independently, and give every consumer queue a dead-letter exchange —
a handler that throws should send the message somewhere you can inspect, not drop it.

## The transactional outbox

**Publishing after a payment succeeds is not atomic.** If the broker is unreachable at
that moment, money moved and no event records it. No amount of retrying inside
`publish()` fixes this, because the process can die between the two operations.

The fix is to make the event part of the same database transaction as the payment:

```ts
// WRONG — two systems, no transaction between them.
await capturePayment();
await rabbit.publish('payment.captured', event);

// RIGHT — one transaction, so they cannot diverge.
await db.transaction(async (tx) => {
  await tx.payments.insert(payment);
  await tx.outbox.insert({ id: uuid(), payload: event, publishedAt: null });
});
```

A relay then polls the outbox, publishes, and marks rows sent once the broker
acknowledges. If publishing fails the row stays unsent and is retried; if the process
dies mid-publish the row is retried and the consumer's idempotency check absorbs the
duplicate.

Two things fall out of this for free:

- **An audit log.** The outbox is a durable, ordered record of everything that happened.
- **Replay.** Re-publishing historical rows feeds a new consumer without touching the
  providers. This is most of the reason people reach for Kafka; an outbox on RabbitMQ
  gets you there for far less operational weight.

Combined with the consumer-side idempotency in [webhooks.md](webhooks.md), this gives
at-least-once delivery end to end.
