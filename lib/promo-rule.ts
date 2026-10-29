// Claim conditions of a tracked promotion. Shared by the rule editor (browser) and the tracking engine (server).

import { tk, type T } from "@/lib/i18n";
import { sym } from "@/lib/format";

export type PromoPeriod = "day" | "week" | "month" | "campaign";
export type PromoBasis = "amount" | "count" | "both";

export type PromoTier = {
  /** Deposits in the period must add up to at least this (basis amount / both). */
  amount: number;
  /** Number of deposits of at least `minEach` (basis count / both). */
  count: number;
  /** Fixed bonus. Ignored when `pct` is set. */
  bonus: number;
  /** Bonus as % of the period's deposits, capped at `cap` (0 = no cap). */
  pct: number;
  cap: number;
};

export type PromoRule = {
  period: PromoPeriod;
  basis: PromoBasis;
  /** A deposit counts towards the number of deposits only from this amount; one big deposit is still one. */
  minEach: number;
  tiers: PromoTier[];
  /** true = every tier reached pays; false = only the highest one. */
  stack: boolean;
  /** Bonus is for the next period, e.g. this month's VIP from last month's deposits. */
  payNext: boolean;
  /** Only players in these tiers (Settings → Player tiers); empty = everyone. */
  playerTiers: string[];
  remind: {
    /** Remind CS at this % of the next tier (0 = off). */
    pct: number;
    /** …or when only this much is missing (0 = off). */
    gapAmount: number;
    /** …or when only this many deposits are missing (0 = off). */
    gapCount: number;
    /** After CS contacted the player, remind again after this many hours if still not reached (0 = never). */
    repeatHours: number;
  };
  /** Tell CS when a player reaches a tier. */
  notifyEligible: boolean;
  expiry: {
    /** none = no deadline; period = until the period ends; hours = this many hours after qualifying. */
    kind: "none" | "period" | "hours";
    hours: number;
    /** Remind CS this many hours before an unclaimed bonus expires (0 = off). */
    warnHours: number;
  };
};

export const PERIODS: { value: PromoPeriod; label: string }[] = [
  { value: "day", label: tk("Daily") },
  { value: "week", label: tk("Weekly") },
  { value: "month", label: tk("Monthly") },
  { value: "campaign", label: tk("Whole campaign") },
];

export const BASES: { value: PromoBasis; label: string }[] = [
  { value: "amount", label: tk("Total deposited") },
  { value: "count", label: tk("Number of deposits") },
  { value: "both", label: tk("Both total and number") },
];

export const EXPIRY: { value: PromoRule["expiry"]["kind"]; label: string }[] = [
  { value: "none", label: tk("No deadline") },
  { value: "period", label: tk("Until the period ends") },
  { value: "hours", label: tk("Hours after qualifying") },
];

export const emptyTier = (): PromoTier => ({ amount: 0, count: 0, bonus: 0, pct: 0, cap: 0 });

export const DEFAULT_RULE: PromoRule = {
  period: "day",
  basis: "amount",
  minEach: 0,
  tiers: [emptyTier()],
  stack: true,
  payNext: false,
  playerTiers: [],
  remind: { pct: 80, gapAmount: 0, gapCount: 0, repeatHours: 0 },
  notifyEligible: true,
  expiry: { kind: "period", hours: 24, warnHours: 2 },
};

const num = (v: unknown, min = 0) => {
  const x = Number(v);
  return Number.isFinite(x) && x >= min ? x : min;
};
const pick = <V extends string>(v: unknown, list: { value: V }[], def: V) => (list.some((o) => o.value === v) ? (v as V) : def);

/** Reads a stored rule, filling anything missing with defaults. */
export function readRule(raw: unknown): PromoRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PromoRule> & Record<string, unknown>;
  const rem = (r.remind ?? {}) as Partial<PromoRule["remind"]>;
  const exp = (r.expiry ?? {}) as Partial<PromoRule["expiry"]>;
  const basis = pick(r.basis, BASES, "amount");
  const tiers = (Array.isArray(r.tiers) ? r.tiers : [])
    .map((t: Partial<PromoTier>) => ({ amount: num(t.amount), count: Math.round(num(t.count)), bonus: num(t.bonus), pct: num(t.pct), cap: num(t.cap) }))
    .filter((t) => (basis !== "count" ? t.amount > 0 : true) && (basis !== "amount" ? t.count > 0 : true));
  return {
    period: pick(r.period, PERIODS, "day"),
    basis,
    minEach: num(r.minEach),
    tiers: sortTiers(tiers, basis),
    stack: r.stack !== false,
    payNext: r.payNext === true,
    playerTiers: Array.isArray(r.playerTiers) ? r.playerTiers.map(String).filter(Boolean) : [],
    remind: { pct: Math.min(num(rem.pct), 100), gapAmount: num(rem.gapAmount), gapCount: Math.round(num(rem.gapCount)), repeatHours: num(rem.repeatHours) },
    notifyEligible: r.notifyEligible !== false,
    expiry: { kind: pick(exp.kind, EXPIRY, "none"), hours: num(exp.hours), warnHours: num(exp.warnHours) },
  };
}

export function sortTiers(tiers: PromoTier[], basis: PromoBasis) {
  return [...tiers].sort((a, b) => (basis === "count" ? a.count - b.count : a.amount - b.amount || a.count - b.count));
}

export function tierMet(rule: PromoRule, t: PromoTier, amount: number, count: number) {
  return (rule.basis === "count" || amount >= t.amount) && (rule.basis === "amount" || count >= t.count);
}

/** Share of the tier done, 0–1. With "both", the part that is further behind counts. */
export function tierShare(rule: PromoRule, t: PromoTier, amount: number, count: number) {
  const a = t.amount > 0 ? Math.min(amount / t.amount, 1) : 1;
  const c = t.count > 0 ? Math.min(count / t.count, 1) : 1;
  return rule.basis === "amount" ? a : rule.basis === "count" ? c : Math.min(a, c);
}

export function tierBonus(t: PromoTier, periodAmount: number) {
  if (t.pct > 0) {
    const b = (periodAmount * t.pct) / 100;
    return Math.round((t.cap > 0 ? Math.min(b, t.cap) : b) * 100) / 100;
  }
  return t.bonus;
}

/** What is still missing to reach a tier. */
export function tierGap(rule: PromoRule, t: PromoTier, amount: number, count: number) {
  return {
    amount: rule.basis === "count" ? 0 : Math.max(0, Math.round((t.amount - amount) * 100) / 100),
    count: rule.basis === "amount" ? 0 : Math.max(0, t.count - count),
  };
}

/** Should CS be told the player is close to this tier? */
export function isNear(rule: PromoRule, t: PromoTier, amount: number, count: number) {
  if (tierMet(rule, t, amount, count)) return false;
  const gap = tierGap(rule, t, amount, count);
  if (rule.remind.pct > 0 && tierShare(rule, t, amount, count) * 100 >= rule.remind.pct) return true;
  // Gap rules: every part that is still missing must be within its limit.
  const amountOk = gap.amount === 0 || (rule.remind.gapAmount > 0 && gap.amount <= rule.remind.gapAmount);
  const countOk = gap.count === 0 || (rule.remind.gapCount > 0 && gap.count <= rule.remind.gapCount);
  const anyGapRule = (gap.amount > 0 && rule.remind.gapAmount > 0) || (gap.count > 0 && rule.remind.gapCount > 0);
  return anyGapRule && amountOk && countOk;
}

/** One-line condition of a tier, e.g. "3 deposits of 30+" or "100 total". */
export function tierText(rule: PromoRule, tr: PromoTier, t: T, cur = "") {
  const c = cur ? sym(cur) + " " : "";
  const parts: string[] = [];
  if (rule.basis !== "count") parts.push(t("{amount} total", { amount: c + tr.amount.toLocaleString("en") }));
  if (rule.basis !== "amount")
    parts.push(rule.minEach > 0 ? t("{n} deposits of {min}+", { n: tr.count, min: c + rule.minEach.toLocaleString("en") }) : t("{n} deposits", { n: tr.count }));
  const reward = tr.pct > 0 ? `${tr.pct}%` + (tr.cap > 0 ? " " + t("(max {cap})", { cap: c + tr.cap.toLocaleString("en") }) : "") : c + tr.bonus.toLocaleString("en");
  return `${parts.join(" + ")} → ${reward}`;
}

/** "2/3 deposits · 1 more" or "80/100 · 20 more". */
export function progressText(rule: PromoRule, tr: PromoTier, amount: number, count: number, t: T, cur = "") {
  const c = cur ? sym(cur) + " " : "";
  const gap = tierGap(rule, tr, amount, count);
  const parts: string[] = [];
  if (rule.basis !== "count") parts.push(`${c}${fmt(amount)}/${fmt(tr.amount)}`);
  if (rule.basis !== "amount") parts.push(t("{a}/{b} deposits", { a: count, b: tr.count }));
  const miss: string[] = [];
  if (gap.amount > 0) miss.push(t("{amount} more", { amount: c + fmt(gap.amount) }));
  if (gap.count > 0) miss.push(gap.count === 1 ? t("1 more deposit") : t("{n} more deposits", { n: gap.count }));
  return parts.join(" · ") + (miss.length ? " · " + miss.join(" + ") : "");
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toLocaleString("en");
