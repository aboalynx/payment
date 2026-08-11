import type { PaymentEvent } from './types';

/**
 * How events leave the package.
 *
 * This is a port, not an implementation. The package depends on no message broker:
 * importing amqplib would force every consumer to run RabbitMQ and rule out Kafka,
 * Redis, SQS, or no broker at all. Applications supply their own.
 */
export interface PaymentEventPublisher {
  publish(event: PaymentEvent): Promise<void>;
}

/** The default. Events are dropped unless an application supplies a publisher. */
export class NoopPublisher implements PaymentEventPublisher {
  publish(_event: PaymentEvent): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Publish without letting a failure escape.
 *
 * Observability must not break payments: if the broker is unreachable after a charge
 * has already succeeded, the charge still succeeded. The failure is reported through
 * `onError` and otherwise swallowed.
 *
 * Applications that cannot lose events should use a transactional outbox — write the
 * event in the same database transaction as the payment record and let a relay publish
 * it. See docs/events.md.
 */
export async function safePublish(
  publisher: PaymentEventPublisher,
  event: PaymentEvent,
  onError?: (error: unknown, event: PaymentEvent) => void,
): Promise<void> {
  try {
    await publisher.publish(event);
  } catch (error) {
    onError?.(error, event);
  }
}
