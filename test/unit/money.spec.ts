import { exponentFor, toDecimalString, toMajorUnit, toMinorUnit } from '../../src/money';

describe('exponentFor', () => {
  it('defaults to 2 decimals', () => {
    expect(exponentFor('USD')).toBe(2);
    expect(exponentFor('EGP')).toBe(2);
  });

  it('knows 3-decimal currencies', () => {
    expect(exponentFor('KWD')).toBe(3);
    expect(exponentFor('BHD')).toBe(3);
  });

  it('knows 0-decimal currencies', () => {
    expect(exponentFor('JPY')).toBe(0);
    expect(exponentFor('KRW')).toBe(0);
  });

  it('is case insensitive', () => {
    expect(exponentFor('jpy')).toBe(0);
  });
});

describe('toMinorUnit', () => {
  it('converts 2-decimal amounts', () => {
    expect(toMinorUnit(49.99, 'USD')).toBe(4999);
    expect(toMinorUnit(0.29, 'USD')).toBe(29);
  });

  // Regression: Math.trunc(19.99 * 100) is 1998 because the product is
  // 1998.9999999999998. Rounding must happen before the cast.
  it('rounds rather than truncating binary float error', () => {
    expect(toMinorUnit(19.99, 'USD')).toBe(1999);
    expect(toMinorUnit(1.005, 'USD')).toBe(100);
  });

  it('scales by the currency exponent', () => {
    expect(toMinorUnit(49.99, 'KWD')).toBe(49990);
    expect(toMinorUnit(4999, 'JPY')).toBe(4999);
  });

  it('handles zero', () => {
    expect(toMinorUnit(0, 'USD')).toBe(0);
  });
});

describe('toMajorUnit', () => {
  // Regression: dividing without fixing precision turns 1999 into 20, not 19.99.
  it('preserves decimals', () => {
    expect(toMajorUnit(1999, 'USD')).toBe(19.99);
    expect(toMajorUnit(29, 'USD')).toBe(0.29);
    expect(toMajorUnit(1234, 'KWD')).toBe(1.234);
    expect(toMajorUnit(4999, 'JPY')).toBe(4999);
  });
});

describe('toDecimalString', () => {
  it('formats with the currency exponent, as PayPal requires', () => {
    expect(toDecimalString(49.9, 'USD')).toBe('49.90');
    expect(toDecimalString(49.999, 'KWD')).toBe('49.999');
    expect(toDecimalString(4999, 'JPY')).toBe('4999');
  });
});

describe('round trip', () => {
  it.each([
    ['USD', 49.99],
    ['USD', 0.01],
    ['USD', 1234.56],
    ['KWD', 49.999],
    ['JPY', 4999],
  ])('%s %d survives a round trip', (currency: string, amount: number) => {
    expect(toMajorUnit(toMinorUnit(amount, currency), currency)).toBe(amount);
  });
});
