// Display-only preview math. The SERVER is authoritative (create_buy_order / create_sell_order / preview_calc);
// this mirrors its rules exactly using BigInt, never floating point:
//   usdt  = trunc(lyd / price, 6)      gross = round_half_up(usdt * price, 2)      fee = round_half_up(gross * pct / 100, 2)
export function toScaled(v: string | number, scale: number): bigint {
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("bad decimal");
  const [i, f = ""] = s.split(".");
  return BigInt(i + (f + "0".repeat(scale)).slice(0, scale));
}
export function fromScaled(n: bigint, scale: number): string {
  const neg = n < 0n; const a = (neg ? -n : n).toString().padStart(scale + 1, "0");
  const i = a.slice(0, a.length - scale), f = a.slice(a.length - scale);
  return (neg ? "-" : "") + (scale ? `${i}.${f}` : i);
}
export const roundDiv = (num: bigint, den: bigint) => (num + den / 2n) / den;   // half-up for non-negative values

export interface BuyCalc { usdt: string; gross: string; fee: string; total: string }
export interface SellCalc { gross: string; fee: string; net: string }

export function calcBuy(price: string | number, feePct: string | number, input: { lyd?: string; usdt?: string }): BuyCalc | null {
  try {
    const P = toScaled(price, 4), F = toScaled(feePct, 4);
    if (P <= 0n) return null;
    const usdtMicro = input.usdt !== undefined && input.usdt !== "" ? toScaled(input.usdt, 6)
      : input.lyd !== undefined && input.lyd !== "" ? (toScaled(input.lyd, 2) * 100_000_000n) / P : 0n;
    if (usdtMicro <= 0n) return null;
    const gross = roundDiv(usdtMicro * P, 100_000_000n);
    const fee = roundDiv(gross * F, 1_000_000n);
    return { usdt: fromScaled(usdtMicro, 6), gross: fromScaled(gross, 2), fee: fromScaled(fee, 2), total: fromScaled(gross + fee, 2) };
  } catch { return null; }
}
export function calcSell(price: string | number, feePct: string | number, usdt: string): SellCalc | null {
  try {
    const P = toScaled(price, 4), F = toScaled(feePct, 4), U = toScaled(usdt, 6);
    if (P <= 0n || U <= 0n) return null;
    const gross = roundDiv(U * P, 100_000_000n);
    const fee = roundDiv(gross * F, 1_000_000n);
    return { gross: fromScaled(gross, 2), fee: fromScaled(fee, 2), net: fromScaled(gross - fee, 2) };
  } catch { return null; }
}
/** true when s is a non-negative decimal with at most `dp` decimals (what the API accepts) */
export const validAmount = (s: string, dp: number) => new RegExp(`^\\d{1,12}(\\.\\d{1,${dp}})?$`).test(s.trim());

/**
 * Normalises what a person types into an amount field: Arabic-Indic and Persian digits become 0-9, the Arabic decimal
 * separator (U+066B) becomes ".", and every other character except "." is dropped. Commas are never treated as decimals.
 */
export function cleanAmount(v: string): string {
  return v
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066b/g, ".")
    .replace(/[^\d.]/g, "");
}
