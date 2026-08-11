# Changelog

All notable changes to `@aboalynx/payment` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

Stages 2 to 5 from the design, each adding capability groups without changing the
existing ones:

- **Webhook management** — create and update webhook subscriptions on both providers.
- **Payment methods** — setup, retrieve and delete, via Stripe PaymentMethods and PayPal
  Vault v3.
- **Saved charge** — charging a stored payment method off-session.
- **Platform** — Stripe Connect and PayPal Partner Referrals behind one interface.
- **Tax** — Stripe only; PayPal has no equivalent API.

---

## [0.1.1] - 2026-08-11

### Added

- An `exports` map, so the public surface is what `index.ts` exports rather than
  anything reachable under `dist/`.

### Changed

- `prepack` now cleans `dist` before building, so a renamed or deleted source file
  cannot leave stale output in the tarball.
- Publishing moved to a release-triggered GitHub Actions job with `--provenance`.

## [0.1.0] - 2026-08-11

First release. Checkout, capture, refund and webhook verification working identically
against Stripe and PayPal.

### Added

- `PaymentService`, the single injectable facade. Every method takes a gateway id first,
  so switching provider is a configuration change rather than a code change.
- `PaymentModule.forRoot` and `forRootAsync`.
- Stripe gateway via the official `stripe` SDK — checkout, capture, refund, webhook
  verification.
- PayPal gateway via the official `@paypal/paypal-server-sdk` — checkout, capture and
  refund through the Orders and Payments controllers, plus webhook verification. The SDK
  ships no webhooks controller, so verification posts to
  `/v1/notifications/verify-webhook-signature` directly.
- Three capability interfaces — `SupportsCheckout`, `SupportsRefunds`,
  `SupportsWebhooks` — that a gateway opts into, with type guards that check both the
  declared capability and the implemented methods.
- A shared contract suite every gateway must pass, so a new gateway goes green against
  tests its author did not write.
- `PaymentEventPublisher`, a port with a no-op default. The package depends on no
  message broker.
- Currency-aware money conversion resolving the ISO-4217 exponent per currency.
- A typed `PaymentError` hierarchy so callers catch one family.

### Security

- Webhook signatures are verified before any payload field is trusted. Stripe uses the
  SDK's `constructEvent`, which performs the timing-safe comparison and the timestamp
  tolerance check; PayPal verifies server-side.
- Credentials are scoped to the gateway instance. Two gateways serving different tenants
  in one process cannot transact through each other's account, and a contract test
  asserts the key actually sent on the wire.
- No credential, token or signing secret is logged, thrown in a message, or placed in an
  event payload.
- Provider errors surface the HTTP status without the response body, which echoes
  billing data back.
- Configuration is validated before any network call, so a missing `webhookId` fails
  immediately rather than after a wasted token exchange.
- Missing identifiers, currencies and amounts raise a `GatewayError` rather than being
  substituted. An empty webhook event id would silently collapse every event into one
  and defeat the idempotency the README asks applications to implement.
- `capture()` is idempotent on both gateways: PayPal's already-captured response is
  detected by its structured `issue` field and the existing capture is read back.

### Requirements

- Node 20+
- NestJS 10 or 11

Tested in CI on Node 20 and 22.

[Unreleased]: https://github.com/aboalynx/payment/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aboalynx/payment/releases/tag/v0.1.0
