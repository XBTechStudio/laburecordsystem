import type { T } from "@/lib/i18n";

const two = new Intl.NumberFormat("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const zero = new Intl.NumberFormat("en-MY", { maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-MY");

type Num = number | string | { toString(): string } | null | undefined;

export function n(v: Num): number {
  if (v == null) return 0;
  const x = typeof v === "number" ? v : Number(v.toString());
  return Number.isFinite(x) ? x : 0;
}

const SYMBOL: Record<string, string> = { MYR: "RM", SGD: "S$", USD: "US$", THB: "฿", IDR: "Rp", PHP: "₱", VND: "₫", CNY: "¥" };
export const sym = (cur = "MYR") => SYMBOL[cur] ?? cur;

export const money = (v: Num, cur?: string) => `${sym(cur)} ${two.format(n(v))}`;
export const money0 = (v: Num, cur?: string) => `${sym(cur)} ${zero.format(Math.round(n(v)))}`;
export const count = (v: Num) => int.format(n(v));
export const pct = (v: number, digits = 1) => (Number.isFinite(v) ? `${v.toFixed(digits)}%` : "–");
export const ratio = (a: number, b: number) => (b ? (a / b) * 100 : 0);

export function short(v: number) {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1000) return `${Math.round(v / 1000)}K`;
  return String(Math.round(v));
}

/** Malaysia time, "2026-10-28 14:30". */
export function dt(d: Date | null | undefined) {
  if (!d) return "–";
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

export function d10(d: Date | null | undefined) {
  return d ? d.toISOString().slice(0, 10) : "–";
}

export function ago(d: Date | null | undefined, t: T, now = new Date()) {
  if (!d) return t("never");
  const days = Math.floor((now.getTime() - d.getTime()) / 86400_000);
  if (days <= 0) return t("today");
  if (days === 1) return t("yesterday");
  return t("{n} days ago", { n: days });
}

export function phoneKey(p: string | null | undefined) {
  const digits = (p ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-9) : null;
}
