// Which period (day / week / month / campaign) a moment belongs to, for promotion tracking.
// Business days are Malaysia/Singapore time (UTC+8) and may start at an hour other than midnight.

import { addDays, dateOnlyStr, monthStart, todayStr } from "@/lib/dates";
import type { PromoPeriod } from "@/lib/promo-rule";

const OFFSET_MS = 8 * 3600_000;

export type PeriodOpts = { dayStartHour: number; weekStartDay: number };
export type Period = { key: string; start: Date; end: Date };

/** Business day of a moment, as "YYYY-MM-DD". */
export function businessDay(at: Date, o: PeriodOpts) {
  return todayStr(new Date(at.getTime() - o.dayStartHour * 3600_000));
}

/** The moment a business day starts. */
export function businessStart(day: string, o: PeriodOpts) {
  return new Date(new Date(day + "T00:00:00Z").getTime() - OFFSET_MS + o.dayStartHour * 3600_000);
}

function firstDay(day: string, period: PromoPeriod, o: PeriodOpts, campaignStart: string | null) {
  if (period === "day") return day;
  if (period === "week") {
    const dow = new Date(day + "T00:00:00Z").getUTCDay() || 7; // 1 = Monday … 7 = Sunday
    return addDays(day, -((dow - o.weekStartDay + 7) % 7));
  }
  if (period === "month") return monthStart(day);
  return campaignStart ?? "2000-01-01";
}

function nextFirstDay(first: string, period: PromoPeriod, campaignEnd: string | null) {
  if (period === "day") return addDays(first, 1);
  if (period === "week") return addDays(first, 7);
  if (period === "month") {
    const d = new Date(first + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 1);
    return dateOnlyStr(d);
  }
  return campaignEnd ? addDays(campaignEnd, 1) : "2100-01-01";
}

export type Campaign = { startDay: Date | null; endDay: Date | null };

const dayStr = (d: Date | null) => (d ? dateOnlyStr(d) : null);

/** The period a moment falls in. */
export function periodAt(at: Date, period: PromoPeriod, o: PeriodOpts, c: Campaign): Period {
  const key = firstDay(businessDay(at, o), period, o, dayStr(c.startDay));
  return { key, start: businessStart(key, o), end: businessStart(nextFirstDay(key, period, dayStr(c.endDay)), o) };
}

export function periodOf(key: string, period: PromoPeriod, o: PeriodOpts, c: Campaign): Period {
  return { key, start: businessStart(key, o), end: businessStart(nextFirstDay(key, period, dayStr(c.endDay)), o) };
}

/** The period right after this one. */
export function nextPeriod(p: Period, period: PromoPeriod, o: PeriodOpts, c: Campaign): Period {
  return periodAt(p.end, period, o, c);
}

/** Part of a period inside the campaign dates: deposits outside it don't count. */
export function clip(p: Period, o: PeriodOpts, c: Campaign) {
  const s = c.startDay ? businessStart(dateOnlyStr(c.startDay), o) : null;
  const e = c.endDay ? businessStart(addDays(dateOnlyStr(c.endDay), 1), o) : null;
  return { start: s && s > p.start ? s : p.start, end: e && e < p.end ? e : p.end };
}

/** Is the campaign running at this moment? */
export function inCampaign(at: Date, o: PeriodOpts, c: Campaign) {
  const day = businessDay(at, o);
  return (!c.startDay || day >= dateOnlyStr(c.startDay)) && (!c.endDay || day <= dateOnlyStr(c.endDay));
}
