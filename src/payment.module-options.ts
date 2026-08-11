import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency } from '@nestjs/common';
import type { PaymentGateway } from './gateway.interface';
import type { PaymentEventPublisher } from './publisher';
import type { PaymentEvent } from './types';

export interface PaymentModuleOptions {
  /** Gateway instances, built by their factories. Order sets `registered` order. */
  gateways: PaymentGateway[];

  /** Where events go. Defaults to a no-op — the package ships no broker. */
  publisher?: PaymentEventPublisher;

  /** Called when publishing fails. Publishing never fails a payment. */
  onPublishError?: (error: unknown, event: PaymentEvent) => void;
}

export interface PaymentModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: never[]) => PaymentModuleOptions | Promise<PaymentModuleOptions>;
  /** Providers to inject into `useFactory`, using Nest's own token type. */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
}
