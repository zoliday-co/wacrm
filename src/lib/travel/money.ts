// ============================================================
// Exact money arithmetic for the travel layer.
//
// Postgres NUMERIC(12,2) columns arrive as strings through
// PostgREST. Doing `Number(a) + Number(b)` on them re-introduces
// binary floating point (0.1 + 0.2 !== 0.3) — exactly the class
// of bug a booking ledger must never have. This module represents
// every amount as an integer count of MINOR UNITS (paise for INR,
// cents for USD…) inside a `bigint`, does all arithmetic there,
// and only formats back to a "1234.50" string at the edges.
//
// Rounding is half-up (the convention on Indian invoices), applied
// once per derived figure — never on intermediate sums.
// ============================================================

/** Amount in minor units (e.g. paise). Always an integer. */
export type Minor = bigint;

const SCALE = 100n;

/** Parse "1234.5", "1,234.50", 1234.5, or a bigint into minor units. */
export function toMinor(value: string | number | bigint | null | undefined): Minor {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0n;
    // Round once at the boundary; numbers only ever come from UI inputs.
    return BigInt(Math.round(value * 100));
  }
  const cleaned = value.replace(/[,\s₹]/g, '');
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!m) return 0n;
  const sign = m[1] ? -1n : 1n;
  const whole = m[2] || '0';
  const frac = (m[3] || '').padEnd(3, '0'); // keep a 3rd digit for rounding
  const wholeMinor = BigInt(whole) * SCALE;
  const fracMinor = BigInt(frac.slice(0, 2));
  const third = Number(frac[2] ?? '0');
  const rounded = fracMinor + (third >= 5 ? 1n : 0n);
  return sign * (wholeMinor + rounded);
}

/** Format minor units back to the canonical "1234.50" NUMERIC string. */
export function fromMinor(minor: Minor): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  return `${negative ? '-' : ''}${whole.toString()}.${frac.toString().padStart(2, '0')}`;
}

export function add(...values: Minor[]): Minor {
  return values.reduce((acc, v) => acc + v, 0n);
}

export function sub(a: Minor, b: Minor): Minor {
  return a - b;
}

export function max0(a: Minor): Minor {
  return a < 0n ? 0n : a;
}

/**
 * Multiply an amount by a percentage expressed as a NUMERIC string
 * (e.g. "5.00", "12.5", "18"). Rounds half-up to the minor unit.
 * Percent precision is 4 decimal places ("12.3456").
 */
export function percentOf(amount: Minor, percent: string | number): Minor {
  const pct = percentToBasisPoints(percent); // 1/10000 of a percent
  const numerator = amount * pct;
  const denominator = 1_000_000n; // 100 (percent) * 10_000 (bp scale)
  return divRoundHalfUp(numerator, denominator);
}

/** "12.3456" → 123456n (percent × 10 000). */
export function percentToBasisPoints(percent: string | number): bigint {
  const str = typeof percent === 'number' ? percent.toFixed(4) : String(percent).trim();
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(str);
  if (!m) return 0n;
  const sign = m[1] ? -1n : 1n;
  const whole = BigInt(m[2] || '0');
  const frac = BigInt((m[3] || '').padEnd(4, '0').slice(0, 4));
  return sign * (whole * 10_000n + frac);
}

/** Integer division with half-up rounding (sign-aware). */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/**
 * Ratio a/b as a percentage string with 2 decimals ("14.29").
 * Returns "0.00" when b is zero.
 */
export function ratioPercent(a: Minor, b: Minor): string {
  if (b === 0n) return '0.00';
  // (a / b) * 100, with 2 decimals → scale by 10 000
  const scaled = divRoundHalfUp(a * 10_000n, b);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`;
}

export function isNegative(a: Minor): boolean {
  return a < 0n;
}

export function compare(a: Minor, b: Minor): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Display formatter — "₹1,23,456.00" style via Intl. Accepts the
 * NUMERIC string or minor units. Never used for arithmetic.
 */
export function formatMoney(
  value: string | number | Minor | null | undefined,
  currency = 'INR',
  opts: { minimumFractionDigits?: number; maximumFractionDigits?: number } = {}
): string {
  const minor = typeof value === 'bigint' ? value : toMinor(value);
  const asNumber = Number(minor) / 100;
  const locale = currency === 'INR' ? 'en-IN' : undefined;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: opts.minimumFractionDigits ?? 0,
      maximumFractionDigits: opts.maximumFractionDigits ?? 2,
    }).format(asNumber);
  } catch {
    return `${currency} ${asNumber.toFixed(2)}`;
  }
}

/** Sum a list of NUMERIC strings → NUMERIC string. */
export function sumStrings(values: (string | number | null | undefined)[]): string {
  return fromMinor(add(...values.map(toMinor)));
}
