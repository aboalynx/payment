# Architecture

Three layers, and deliberately no more.

```
 Service      PaymentService — the facade applications inject
     |
 Gateway      StripeGateway, PaypalGateway — capability interfaces
     |
 SDK client   stripe, @paypal/paypal-server-sdk
```

---

## The layers

**Service.** `PaymentService` is the only thing an application injects. Every method
takes a gateway id first, so switching provider is a configuration change rather than a
code change. It checks the capability before dispatching, so an unsupported operation
fails immediately with `UnsupportedOperationError` rather than as a confusing provider
error three layers down.

**Gateway.** One class per provider. Translates the shared vocabulary into SDK calls and
provider responses back into shared result types. Holds its own credentials.

**SDK client.** The official provider SDK, constructed with the credentials the gateway
was given.

## Why capability interfaces

The obvious design is one `PaymentGateway` interface with every operation on it, optional
where a provider does not support it. That works for four operations and collapses at
twenty: every gateway declares a long list of capabilities, most of them false, and
"what does this provider actually do?" becomes unanswerable without reading the whole
class.

Instead operations are grouped:

```ts
interface PaymentGateway {
  id;
  currencies;
  capabilities;
} // stays at three members

interface SupportsCheckout {
  checkout();
  capture();
}
interface SupportsRefunds {
  refund();
}
interface SupportsWebhooks {
  verifyWebhook();
}
```

A gateway implements the groups its provider supports. Adding an operation to a group is
an interface change plus implementations; adding a group is a new file that touches
nothing existing.

`capabilities` survives alongside the interfaces for runtime checks
(`payments.supports('paypal', 'refund')`), while the interfaces give compile-time
narrowing.

**The guards check both.** A gateway that declares `checkout` but forgets to implement
`capture` would otherwise fail at call time with a `TypeError`. `isCheckoutCapable`
verifies the declaration _and_ the methods, and the contract suite runs that check
against every gateway.

## Credentials are per instance

Each gateway builds its provider client from the options it was constructed with. There
is no module-level client and no process-global key.

This matters in exactly one scenario, which is common in the applications this package
targets: two gateways serving different tenants, alive in the same process — a queue
worker looping tenants, Octane-style persistent workers, an artisan-equivalent
reconcile job. With a shared global, whichever authorised last wins and the earlier
gateway silently transacts through the wrong account.

A contract test asserts the credential actually sent on the wire after a second gateway
is constructed.

## Money

Amounts cross the public API in major units (`49.99`). Conversion happens inside the
gateway, through one helper that resolves the ISO-4217 exponent per currency.

Two rules the helper exists to enforce, both from real bugs:

- **Round before casting.** `Math.trunc(19.99 * 100)` is `1998`, because the product is
  `1998.9999999999998`.
- **Fix precision when converting back.** `1999 / 100` must yield `19.99`, not `20`.

Providers disagree on format: Stripe takes minor units, PayPal takes a decimal string
(`"49.90"`). Both come from the same helper, so neither is the caller's problem.

## What is deliberately absent

**No HTTP routes.** A library that registers a controller imposes its routing on every
consumer. Applications expose their own webhook endpoint and call
`payments.verifyWebhook()`.

**No persistence.** The package takes a request, calls a provider, returns a typed
result. It holds no database abstraction, which means it also cannot answer "have I seen
this webhook before?" — [idempotency is the application's job](webhooks.md).

**No message broker.** Events leave through a port with a no-op default. Importing
`amqplib` would force RabbitMQ on everyone and rule out Kafka, SQS, or nothing.

Each of these was considered and rejected for the same reason: they are application
concerns, and a library that ships them forces its own opinions onto every consumer.

## Errors

One family, so callers catch `PaymentError` rather than provider-specific types:

| Error                       | When                                               |
| --------------------------- | -------------------------------------------------- |
| `UnknownGatewayError`       | The gateway id was never registered                |
| `UnsupportedOperationError` | The gateway does not declare the needed capability |
| `GatewayError`              | The provider rejected the request                  |
| `WebhookVerificationError`  | A signature did not verify                         |
| `ConfigurationError`        | The gateway is missing something it requires       |

Messages carry the HTTP status but never the provider's response body — those echo
billing data back and must not reach a log or a bug report.

## Testing

```
test/
  unit/         money, errors, capability guards, service dispatch
  gateways/     per-provider behaviour
  contract/     the suite every gateway must pass
  integration/  module wiring
  support/      transport fakes
```

Tests mirror `src/` and never sit beside the file under test.

No test reaches a real API. Stripe is intercepted through the SDK's pluggable
`httpClient`; PayPal through `nock`. Both fakes expose the outbound request, so tests
assert on what was actually sent — including the `Authorization` header, which is the
only thing that decides which account is charged.
