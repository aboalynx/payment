import { Test } from '@nestjs/testing';
import { createPaypalGateway } from '../../src/gateways/paypal/paypal.gateway';
import { createStripeGateway } from '../../src/gateways/stripe/stripe.gateway';
import { PaymentModule } from '../../src/payment.module';
import { PaymentService } from '../../src/payment.service';

function stripe() {
  return createStripeGateway({ apiKey: 'sk_test', webhookSecret: 'whsec_test' });
}

function paypal() {
  return createPaypalGateway({
    clientId: 'id',
    clientSecret: 'sec',
    environment: 'sandbox',
    webhookId: 'WH-ID',
  });
}

describe('PaymentModule', () => {
  it('registers both gateways through forRoot', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PaymentModule.forRoot({ gateways: [stripe(), paypal()] })],
    }).compile();

    const service = moduleRef.get(PaymentService);

    expect(service.registered).toEqual(['stripe', 'paypal']);
    expect(service.supports('stripe', 'webhooks')).toBe(true);
    expect(service.supports('paypal', 'refund')).toBe(true);
  });

  it('resolves options through forRootAsync', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PaymentModule.forRootAsync({
          useFactory: () => ({ gateways: [stripe()] }),
        }),
      ],
    }).compile();

    expect(moduleRef.get(PaymentService).registered).toEqual(['stripe']);
  });

  it('exposes the same capability set from both gateways', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PaymentModule.forRoot({ gateways: [stripe(), paypal()] })],
    }).compile();

    const service = moduleRef.get(PaymentService);

    for (const gateway of ['stripe', 'paypal']) {
      expect(service.supports(gateway, 'checkout')).toBe(true);
      expect(service.supports(gateway, 'refund')).toBe(true);
      expect(service.supports(gateway, 'webhooks')).toBe(true);
    }
  });
});
