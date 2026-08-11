/**
 * Currencies PayPal settles in.
 *
 * Validating locally means an unsupported currency fails before a network round-trip,
 * with a clear error rather than a provider 422.
 */
export const PAYPAL_CURRENCIES: ReadonlySet<string> = new Set([
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'ILS',
  'JPY',
  'MXN',
  'MYR',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'SEK',
  'SGD',
  'THB',
  'TWD',
  'USD',
]);
