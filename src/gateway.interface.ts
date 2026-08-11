import type { Capability } from './capabilities';

/**
 * What every gateway must provide, and nothing more.
 *
 * Operations live in the capability interfaces in `capabilities.ts` rather than here,
 * so this contract does not grow every time a provider adds a feature.
 */
export interface PaymentGateway {
  /** Stable identifier used to select this gateway, e.g. 'stripe'. */
  readonly id: string;

  /** Currencies this gateway accepts, or `null` for no restriction. */
  readonly currencies: ReadonlySet<string> | null;

  /** What this gateway can do. Checked before dispatch. */
  readonly capabilities: ReadonlySet<Capability>;
}

/** Builds a configured gateway. Registered in the built-in list. */
export type GatewayFactory = () => PaymentGateway;
