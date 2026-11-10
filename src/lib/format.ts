const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf6 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
export const lyd = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : `${nf2.format(Number(v))} د.ل`);
export const usdt = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : `${nf6.format(Number(v))} USDT`);
export const price = (v: unknown) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(4).replace(/0{1,2}$/, "")} د.ل`);
let tz = "Africa/Tripoli";
export const setTimezone = (z: string) => { try { new Intl.DateTimeFormat("en", { timeZone: z }); tz = z; } catch { /* keep default */ } };
export function dt(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v)); if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-LY-u-nu-latn", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(d);
}
export const mask = (s?: string | null, keep = 4) => (!s ? "—" : s.length <= keep ? s : "•".repeat(Math.max(4, s.length - keep)) + s.slice(-keep));
export const short = (s?: string | null, n = 10) => (!s ? "—" : s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);
export const ago = (v: unknown) => {
  const s = Math.floor((Date.now() - new Date(String(v)).getTime()) / 1000);
  if (s < 60) return "الآن"; if (s < 3600) return `منذ ${Math.floor(s / 60)} د`; if (s < 86400) return `منذ ${Math.floor(s / 3600)} س`;
  return `منذ ${Math.floor(s / 86400)} يوم`;
};
