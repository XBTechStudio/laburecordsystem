import { tk } from "@/lib/i18n";

// All business days are Malaysia time (UTC+8). Timestamps are stored in UTC;
// @db.Date columns hold the Malaysia calendar day at UTC midnight.

const OFFSET_MS = 8 * 3600_000;

export function todayStr(now = new Date()) {
  return new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Start of a Malaysia calendar day, as a UTC instant. */
export function dayStart(day: string) {
  return new Date(new Date(day + "T00:00:00Z").getTime() - OFFSET_MS);
}

/** Value for a @db.Date column. */
export function dateOnly(day: string) {
  return new Date(day + "T00:00:00Z");
}

export function dateOnlyStr(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Malaysia day of a UTC instant. */
export function dayOf(d: Date) {
  return todayStr(d);
}

/** "YYYY-MM-DDTHH:mm" for <input type="datetime-local">, Malaysia time. */
export function toLocalInput(d: Date) {
  return new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 16);
}

export function fromLocalInput(v: string) {
  return new Date(new Date(v + ":00Z").getTime() - OFFSET_MS);
}

export function daysBetween(a: string, b: string) {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400_000);
}

export function mondayOf(day: string) {
  const dow = new Date(day + "T00:00:00Z").getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

export function monthStart(day: string) {
  return day.slice(0, 8) + "01";
}

export function monthEnd(day: string) {
  const d = new Date(monthStart(day) + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export type Range = { from: string; to: string };

export const PRESETS = [
  { id: "today", label: tk("Today") },
  { id: "yesterday", label: tk("Yesterday") },
  { id: "week", label: tk("This week") },
  { id: "month", label: tk("This month") },
  { id: "lastMonth", label: tk("Last month") },
  { id: "30d", label: tk("Last 30 days") },
] as const;

export function presetRange(id: string, today = todayStr()): Range | null {
  switch (id) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "week":
      return { from: mondayOf(today), to: today };
    case "month":
      return { from: monthStart(today), to: today };
    case "lastMonth": {
      const last = addDays(monthStart(today), -1);
      return { from: monthStart(last), to: last };
    }
    case "30d":
      return { from: addDays(today, -29), to: today };
  }
  return null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRange(sp: { from?: string; to?: string; preset?: string }, fallback = "month"): Range & { preset?: string } {
  if (sp.from && sp.to && DAY_RE.test(sp.from) && DAY_RE.test(sp.to)) {
    return sp.from <= sp.to ? { from: sp.from, to: sp.to } : { from: sp.to, to: sp.from };
  }
  const id = sp.preset ?? fallback;
  return { ...(presetRange(id) ?? presetRange(fallback)!), preset: id };
}

export function previousRange(r: Range): Range {
  const len = daysBetween(r.from, r.to) + 1;
  return { from: addDays(r.from, -len), to: addDays(r.from, -1) };
}

/** Prisma filter for a UTC timestamp column covering whole Malaysia days. */
export function instantRange(r: Range) {
  return { gte: dayStart(r.from), lt: dayStart(addDays(r.to, 1)) };
}

export function allDaysOf(r: Range) {
  const out: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dateRange(r: Range) {
  return { gte: dateOnly(r.from), lte: dateOnly(r.to) };
}
