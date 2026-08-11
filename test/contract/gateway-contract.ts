import type { Capability } from '../../src/capabilities';
import { isCheckoutCapable, isRefundCapable, isWebhookCapable } from '../../src/capabilities';
import type { PaymentGateway } from '../../src/gateway.interface';

/**
 * The suite every gateway must pass.
 *
 * This is what makes "extensible" real: a new gateway goes green against tests its
 * author did not write. Add a spec file that calls this with your factory, and the
 * invariants below are checked for free.
 */
export function describeGatewayContract(name: string, build: () => PaymentGateway): void {
  describe(`${name} gateway contract`, () => {
    it('has a non-empty id', () => {
      expect(build().id).toMatch(/\S/);
    });

    it('declares at least one capability', () => {
      expect(build().capabilities.size).toBeGreaterThan(0);
    });

    it('exposes currencies as a set or null, never an array', () => {
      const currencies = build().currencies;
      expect(currencies === null || currencies instanceof Set).toBe(true);
    });

    it('uses upper-case currency codes', () => {
      const currencies = build().currencies;
      if (!currencies) return;
      for (const code of currencies) {
        expect(code).toBe(code.toUpperCase());
      }
    });

    // Declaring a capability without implementing its methods is the drift the guards
    // exist to catch. A gateway that fails here would throw TypeError at call time.
    it('implements every capability it declares', () => {
      const gateway = build();
      const checks: Record<Capability, (g: PaymentGateway) => boolean> = {
        checkout: isCheckoutCapable,
        refund: isRefundCapable,
        webhooks: isWebhookCapable,
      };

      for (const capability of gateway.capabilities) {
        expect({ capability, implemented: checks[capability](gateway) }).toEqual({
          capability,
          implemented: true,
        });
      }
    });

    it('does not claim capabilities it has not declared', () => {
      const gateway = build();
      if (!gateway.capabilities.has('refund')) {
        expect(isRefundCapable(gateway)).toBe(false);
      }
      if (!gateway.capabilities.has('webhooks')) {
        expect(isWebhookCapable(gateway)).toBe(false);
      }
      if (!gateway.capabilities.has('checkout')) {
        expect(isCheckoutCapable(gateway)).toBe(false);
      }
    });

    it('builds independent instances rather than sharing state', () => {
      expect(build()).not.toBe(build());
    });
  });
}
