/**
 * Conversion between major units (what a customer sees: 49.99) and the minor units
 * most gateways transact in (4999).
 *
 * The exponent is resolved per ISO-4217 currency rather than assumed to be 2, because
 * KWD has three decimal places and JPY has none.
 */

/** Currencies billed in thousandths (ISO-4217 exponent 3). */
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** Currencies with no minor unit at all (ISO-4217 exponent 0). */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'HUF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** Number of decimal places the given currency is denominated in. */
export function exponentFor(currency: string): number {
  const code = currency.toUpperCase();
  if (THREE_DECIMAL.has(code)) return 3;
  if (ZERO_DECIMAL.has(code)) return 0;
  return 2;
}

/**
 * 49.99 USD -> 4999
 *
 * Rounds before returning: `Math.trunc(19.99 * 100)` is 1998, because the product is
 * 1998.9999999999998 in binary floating point.
 */
export function toMinorUnit(amount: number, currency: string): number {
  return Math.round(amount * 10 ** exponentFor(currency));
}

/**
 * 4999 USD -> 49.99
 *
 * The precision step is required: 1999 / 100 must yield 19.99, not 20.
 */
export function toMajorUnit(amount: number, currency: string): number {
  const exponent = exponentFor(currency);
  return Number((amount / 10 ** exponent).toFixed(exponent));
}

/**
 * 49.9 USD -> "49.90"
 *
 * PayPal's Orders API takes a decimal string with the currency's full precision,
 * not minor units.
 */
export function toDecimalString(amount: number, currency: string): string {
  return amount.toFixed(exponentFor(currency));
}
