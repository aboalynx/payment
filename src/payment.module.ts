import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { PAYMENT_MODULE_OPTIONS } from './payment.constants';
import type { PaymentModuleAsyncOptions, PaymentModuleOptions } from './payment.module-options';
import { PaymentService } from './payment.service';

/**
 * Standard Nest dynamic module.
 *
 *     PaymentModule.forRoot({
 *       gateways: [createStripeGateway({ apiKey }), createPaypalGateway({ ... })],
 *     })
 *
 * or, when credentials come from ConfigService:
 *
 *     PaymentModule.forRootAsync({
 *       inject: [ConfigService],
 *       useFactory: (config: ConfigService) => ({
 *         gateways: [createStripeGateway({ apiKey: config.getOrThrow('STRIPE_SECRET') })],
 *       }),
 *     })
 *
 * Not @Global(): a library should not decide it is global for every consumer. Import
 * PaymentModule where PaymentService is needed, or wrap it in your own global module
 * if that is what your application wants.
 */
@Module({})
export class PaymentModule {
  static forRoot(options: PaymentModuleOptions): DynamicModule {
    return {
      module: PaymentModule,
      providers: [{ provide: PAYMENT_MODULE_OPTIONS, useValue: options }, PaymentService],
      exports: [PaymentService],
    };
  }

  static forRootAsync(options: PaymentModuleAsyncOptions): DynamicModule {
    return {
      module: PaymentModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: PAYMENT_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        PaymentService,
      ],
      exports: [PaymentService],
    };
  }
}
