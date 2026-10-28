// Pairs a day's statement lines with the deposits and withdrawals recorded in the system.
// Plain functions with no app imports, so they can be tried out on their own.

import type { LineKind, StatementLine } from "./statement-parse";

export type PgLine = StatementLine & { i: number; at: Date };
export type SysTxn = {
  id: number;
  type: "DEPOSIT" | "WITHDRAW";
  amount: number;
  at: Date;
  playerId: number;
  username: string;
  name: string | null;
  ref: string | null;
  enteredBy: string | null;
};
/** `late`: same amount and name, but further apart in time than the window allows. */
export type Pair = { pg: PgLine; sys: SysTxn; minutes: number; sameName: boolean; late: boolean };
export type DayMatch = { pairs: Pair[]; pgOnly: PgLine[]; sysOnly: SysTxn[]; reversed: PgLine[] };

const KIND: Record<LineKind, SysTxn["type"]> = { IN: "DEPOSIT", OUT: "WITHDRAW" };
const cents = (v: number) => Math.round(v * 100);
const words = (s: string | null) =>
  (s ?? "")
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Statements show the first word of the bank account name ("ALINE"); a player's full name may be on file ("Aline Tan"). */
export function sameName(pgName: string, sys: SysTxn) {
  const first = words(pgName)[0];
  return !!first && words(sys.name).includes(first);
}

/** Gives each line its instant: the page lists times of day for the statement day (Malaysia/Singapore time). */
export function withTimes(lines: StatementLine[], dayStart: Date): PgLine[] {
  return lines.map((l, i) => {
    const [h, m, s] = l.t.split(":").map(Number);
    return { ...l, i, at: new Date(dayStart.getTime() + ((h * 60 + m) * 60 + (s || 0)) * 1000) };
  });
}

/**
 * Each line is paired with a recorded transaction of the same kind and exact amount, closest in time within `minutes`;
 * a matching name wins over a closer time. What is left is paired again when amount and name match at any time (marked late).
 * A negative line cancels the closest earlier line with the same name and amount (a payment that was reversed).
 * `sys` may include transactions a little outside the day; they only count as unmatched when they fall in [from, to).
 */
export function matchDay(lines: PgLine[], sys: SysTxn[], opts: { minutes: number; from: Date; to: Date }): DayMatch {
  const reversed = new Set<number>();
  for (const neg of lines.filter((l) => l.amount < 0)) {
    reversed.add(neg.i);
    const original = lines
      .filter((l) => l.k === neg.k && l.amount > 0 && !reversed.has(l.i) && l.at <= neg.at && cents(l.amount) === -cents(neg.amount) && words(l.name)[0] === words(neg.name)[0])
      .at(-1);
    if (original) reversed.add(original.i);
  }
  const open = lines.filter((l) => !reversed.has(l.i));

  const pairs: Pair[] = [];
  const pgDone = new Set<number>();
  const sysDone = new Set<number>();
  const pass = (late: boolean) => {
    const byAmount = new Map<string, SysTxn[]>();
    for (const s of sys) {
      if (sysDone.has(s.id)) continue;
      const key = `${s.type}|${cents(s.amount)}`;
      byAmount.set(key, [...(byAmount.get(key) ?? []), s]);
    }
    const options: Pair[] = [];
    for (const l of open) {
      if (pgDone.has(l.i)) continue;
      for (const s of byAmount.get(`${KIND[l.k]}|${cents(l.amount)}`) ?? []) {
        const minutes = Math.abs(s.at.getTime() - l.at.getTime()) / 60_000;
        const same = sameName(l.name, s);
        if (late ? same && minutes > opts.minutes : minutes <= opts.minutes) options.push({ pg: l, sys: s, minutes, sameName: same, late });
      }
    }
    options.sort((a, b) => Number(b.sameName) - Number(a.sameName) || a.minutes - b.minutes);
    for (const o of options) {
      if (pgDone.has(o.pg.i) || sysDone.has(o.sys.id)) continue;
      pgDone.add(o.pg.i);
      sysDone.add(o.sys.id);
      pairs.push(o);
    }
  };
  pass(false);
  pass(true);

  return {
    pairs: pairs.sort((a, b) => a.pg.at.getTime() - b.pg.at.getTime()),
    pgOnly: open.filter((l) => !pgDone.has(l.i)),
    sysOnly: sys.filter((s) => !sysDone.has(s.id) && s.at >= opts.from && s.at < opts.to).sort((a, b) => a.at.getTime() - b.at.getTime()),
    reversed: lines.filter((l) => reversed.has(l.i)),
  };
}
