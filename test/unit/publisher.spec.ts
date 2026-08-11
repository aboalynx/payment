import { NoopPublisher, safePublish } from '../../src/publisher';
import type { PaymentEvent } from '../../src/types';

const event: PaymentEvent = {
  name: 'checkout.created',
  gateway: 'stripe',
  reference: 'ref-1',
  sessionId: 'cs_1',
};

describe('NoopPublisher', () => {
  it('accepts an event and resolves', async () => {
    await expect(new NoopPublisher().publish(event)).resolves.toBeUndefined();
  });
});

describe('safePublish', () => {
  it('forwards the event to the publisher', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    await safePublish({ publish }, event);
    expect(publish).toHaveBeenCalledWith(event);
  });

  // A broker outage must never fail a payment that already succeeded.
  it('swallows a publisher rejection', async () => {
    const publish = jest.fn().mockRejectedValue(new Error('broker down'));
    await expect(safePublish({ publish }, event)).resolves.toBeUndefined();
  });

  it('reports the failure to the error callback', async () => {
    const onError = jest.fn();
    await safePublish(
      { publish: jest.fn().mockRejectedValue(new Error('broker down')) },
      event,
      onError,
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), event);
  });

  it('swallows a synchronous throw too', async () => {
    const publish = jest.fn(() => {
      throw new Error('sync boom');
    });
    await expect(safePublish({ publish }, event)).resolves.toBeUndefined();
  });
});
