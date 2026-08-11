# Adding a gateway

A new provider means one directory, one factory, one line in the barrel, and one spec
file. Nothing existing gets edited.

---

## 1. Declare what the provider can do

Implement `PaymentGateway` plus the capability interfaces the provider actually
supports. Implementing only some is the point — a provider that cannot refund simply
does not implement `SupportsRefunds`.

```ts
// src/gateways/adyen/adyen.gateway.ts
import type { Capability, SupportsCheckout, SupportsWebhooks } from '../../capabilities';
import { ConfigurationError, GatewayError } from '../../errors';
import { toMinorUnit } from '../../money';
import type { AdyenOptions } from './adyen.options';

const GATEWAY_ID = 'adyen';

class AdyenGateway implements SupportsCheckout, SupportsWebhooks {
  readonly id = GATEWAY_ID;

  // Must match the methods you implemented. The contract suite checks this.
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['checkout', 'webhooks']);

  readonly currencies: ReadonlySet<string> | null = new Set(['EUR', 'GBP', 'USD']);

  constructor(protected readonly options: AdyenOptions) {
    if (!options.apiKey) throw new ConfigurationError(GATEWAY_ID, 'apiKey is required');
  }

  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    /* ... */
  }
  async capture(request: CaptureRequest): Promise<CaptureResult> {
    /* ... */
  }
  async verifyWebhook(request: WebhookRequest): Promise<WebhookEvent> {
    /* ... */
  }
}

export function createAdyenGateway(options: AdyenOptions): AdyenGateway {
  return new AdyenGateway(options);
}
```

Four rules the existing gateways follow:

- **Credentials live on the instance.** Build the provider client in the constructor
  from the options this gateway was given. Never a module-level or process-global key —
  two gateways serving different tenants must not be able to transact through each
  other's account.
- **Amounts arrive in major units.** Convert with `toMinorUnit` or `toDecimalString`
  from `../../money`. Never write `amount * 100`.
- **Wrap provider errors.** Catch the SDK's error type and rethrow as `GatewayError` so
  callers only ever handle the `PaymentError` family. Include the HTTP status, never the
  response body — it echoes billing data back.
- **Validate before the network.** Reject an unsupported currency locally so it fails
  with a clear error rather than a provider 400.

## 2. Register it

Export the factory from `src/index.ts`:

```ts
export { createAdyenGateway } from './gateways/adyen/adyen.gateway';
export type { AdyenOptions } from './gateways/adyen/adyen.options';
```

Applications then pass it to the module like any other:

```ts
PaymentModule.forRoot({ gateways: [createAdyenGateway({ apiKey })] });
```

## 3. Pass the contract suite

One file. It gives you seven checks you did not write:

```ts
// test/contract/adyen.contract.spec.ts
import { createAdyenGateway } from '../../src/gateways/adyen/adyen.gateway';
import { describeGatewayContract } from './gateway-contract';

describeGatewayContract('adyen', () => createAdyenGateway({ apiKey: 'test' }));
```

It verifies that the id is non-empty, that at least one capability is declared, that
currencies are an upper-case `Set` or `null`, that **every declared capability is
actually implemented**, that no undeclared capability is implemented, and that the
factory returns independent instances.

That fourth check is the one that matters most: declaring `checkout` but forgetting
`capture` would otherwise surface as a `TypeError` at call time instead of a clear
`UnsupportedOperationError`.

## 4. Test the behaviour

Contract tests prove the shape; they say nothing about correctness. Each capability
needs its own tests covering the success path, the provider-error path, and the
validation path.

Intercept at the transport layer so no test can reach the real API:

- **An SDK with a pluggable HTTP client** — use it. `test/support/stripe-fake.ts` shows
  the pattern, and exposes the outbound request so you can assert on the
  `Authorization` header.
- **Anything else** — use `nock`, as the PayPal tests do.

At minimum:

```ts
it('sends the amount in minor units', ...);
it('sends its own credentials', ...);
it('wraps a provider rejection in GatewayError', ...);
it('rejects an unsupported currency before calling out', ...);
```

## Checklist for the PR

- [ ] `capabilities` matches the methods implemented
- [ ] Credentials held on the instance, never a global
- [ ] Amounts converted through `money.ts`
- [ ] Provider errors wrapped as `GatewayError`, response body dropped
- [ ] Currency validated before any network call
- [ ] No credential, token or customer PII logged or put in an event
- [ ] Contract spec added and green
- [ ] Success, failure and validation tests per capability
- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test` all pass

## Adding an operation rather than a gateway

To add a capability group — payment methods, saved charges, platform onboarding, tax —
add a new interface to `src/capabilities.ts`, a matching type guard, and a member to the
`Capability` union. Then add the dispatch method to `PaymentService` and the check to
the contract suite's `checks` map.

Existing gateways are unaffected: they simply do not declare the new capability, and
`PaymentService` throws `UnsupportedOperationError` for them.
