import "server-only";

import { UserError } from "@/lib/action";
import { addDays, dateOnly, dayStart } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { n } from "@/lib/format";
import { tk } from "@/lib/i18n";
import { matchDay, withTimes, type DayMatch, type SysTxn } from "@/lib/statement-match";
import { parseStatement, type ParsedStatement, type StatementLine } from "@/lib/statement-parse";

/** Problems reading a page. Kept on the account in English and translated where shown. */
class StatementError extends Error {}

/** Cleans up a statement link someone pasted: https only, a normal web address, without the day/hour part. */
export function checkStatementUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UserError("That doesn't look like a web link.");
  }
  if (u.protocol !== "https:") throw new UserError("The statement link must start with https://");
  const host = u.hostname.toLowerCase();
  // Only public web addresses: the server fetches this page by itself.
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host === "localhost" || /\.(local|internal|localhost)$/.test(host))
    throw new UserError("Use the statement page's normal web address.");
  u.hash = "";
  for (const k of ["d", "from", "to"]) u.searchParams.delete(k);
  return u.toString();
}

/** One day of the statement page, or null when the page has nothing for that day. */
async function readStatement(url: string, day: string): Promise<ParsedStatement | null> {
  const u = new URL(url);
  u.searchParams.set("d", day);
  u.searchParams.set("from", "0");
  u.searchParams.set("to", "24");
  let r: Response;
  try {
    r = await fetch(u, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (statement reader)" }, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new StatementError(tk("Couldn't reach the statement page."));
  }
  if (r.status === 404) throw new StatementError(tk("The statement link no longer works (page not found)."));
  if (r.status >= 300 && r.status < 400) throw new StatementError(tk("The statement page has moved. Please update the link."));
  if (!r.ok) throw new StatementError(tk("The statement page didn't answer properly. It will be tried again."));
  const p = parseStatement(await r.text());
  if (p.totalIn == null && p.totalOut == null && p.lines.length === 0) throw new StatementError(tk("This page doesn't look like a statement the system can read."));
  // Pages show their latest day when asked for a day they don't have.
  return p.day && p.day !== day ? null : p;
}

const total = (lines: StatementLine[], k: "IN" | "OUT") => Math.round(lines.filter((l) => l.k === k).reduce((a, l) => a + l.amount, 0) * 100) / 100;

/** Reads the day's statement for every account that has a link (or just the given ones) and keeps it. */
export async function syncStatements(day: string, ids?: number[]) {
  const accounts = await prisma.payChannel.findMany({
    where: { active: true, statementUrl: { not: null }, ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, statementUrl: true },
  });
  const out = { read: 0, empty: 0, failed: 0 };
  for (const a of accounts) {
    try {
      const p = await readStatement(a.statementUrl!, day);
      // A day the page has nothing for is kept as an empty statement: anything recorded that day then shows as not on the statement.
      const data = p
        ? { totalIn: p.totalIn ?? total(p.lines, "IN"), shouldPay: p.shouldPay, totalOut: p.totalOut ?? total(p.lines, "OUT"), remaining: p.remaining, lines: p.lines, readAt: new Date() }
        : { totalIn: 0, shouldPay: null, totalOut: 0, remaining: null, lines: [], readAt: new Date() };
      const key = { channelId_day: { channelId: a.id, day: dateOnly(day) } };
      const before = await prisma.statementDay.findUnique({ where: key, select: { totalIn: true, totalOut: true, lines: true } });
      // New lines since someone signed the day off: they need to look again.
      const changed = before && (n(before.totalIn) !== data.totalIn || n(before.totalOut) !== data.totalOut || (before.lines as unknown[]).length !== data.lines.length);
      await prisma.statementDay.upsert({
        where: key,
        create: { channelId: a.id, day: dateOnly(day), ...data },
        update: { ...data, ...(changed ? { checkedBy: null, checkedAt: null } : {}) },
      });
      if (p) out.read++;
      else out.empty++;
      await prisma.payChannel.update({ where: { id: a.id }, data: { statementReadAt: new Date(), statementError: null } });
    } catch (e) {
      out.failed++;
      const msg = e instanceof StatementError ? e.message : tk("Couldn't reach the statement page.");
      if (!(e instanceof StatementError)) console.error("statement read", a.id, e);
      await prisma.payChannel.update({ where: { id: a.id }, data: { statementReadAt: new Date(), statementError: msg } });
    }
  }
  return out;
}

export type AccountDay = {
  /** What the statement page said, or null if it hasn't been read for this day. */
  statement: { totalIn: number; shouldPay: number | null; totalOut: number; remaining: number | null; readAt: Date; checkedBy: string | null; checkedAt: Date | null; note: string | null } | null;
  match: DayMatch | null;
  /** Deposits and withdrawals recorded in the system for this account on this day. */
  system: { dep: number; depCount: number; wd: number; wdCount: number };
  /** Lines on one side only; 0 when everything pairs up. */
  open: number;
};

/** Statement against system for each account on one day. `minutes`: how far apart in time a pair may be. */
export async function accountDays(day: string, ids: number[], minutes: number): Promise<Map<number, AccountDay>> {
  const from = dayStart(day);
  const to = dayStart(addDays(day, 1));
  const pad = minutes * 60_000;
  const [days, txns] = await Promise.all([
    ids.length ? prisma.statementDay.findMany({ where: { day: dateOnly(day), channelId: { in: ids } } }) : Promise.resolve([]),
    ids.length
      ? prisma.txn.findMany({
          where: { channelId: { in: ids }, txnAt: { gte: new Date(from.getTime() - pad), lt: new Date(to.getTime() + pad) } },
          include: { player: { select: { username: true, name: true } }, createdBy: { select: { name: true } } },
        })
      : Promise.resolve([]),
  ]);
  const out = new Map<number, AccountDay>();
  for (const id of ids) {
    const sys: SysTxn[] = txns
      .filter((x) => x.channelId === id)
      .map((x) => ({ id: x.id, type: x.type, amount: n(x.amount), at: x.txnAt, playerId: x.playerId, username: x.player.username, name: x.player.name, ref: x.ref, enteredBy: x.createdBy?.name ?? null }));
    const inDay = sys.filter((s) => s.at >= from && s.at < to);
    const system = {
      dep: inDay.filter((s) => s.type === "DEPOSIT").reduce((a, s) => a + s.amount, 0),
      depCount: inDay.filter((s) => s.type === "DEPOSIT").length,
      wd: inDay.filter((s) => s.type === "WITHDRAW").reduce((a, s) => a + s.amount, 0),
      wdCount: inDay.filter((s) => s.type === "WITHDRAW").length,
    };
    const d = days.find((x) => x.channelId === id);
    const match = d ? matchDay(withTimes(d.lines as StatementLine[], from), sys, { minutes, from, to }) : null;
    out.set(id, {
      statement: d
        ? { totalIn: n(d.totalIn), shouldPay: d.shouldPay == null ? null : n(d.shouldPay), totalOut: n(d.totalOut), remaining: d.remaining == null ? null : n(d.remaining), readAt: d.readAt, checkedBy: d.checkedBy, checkedAt: d.checkedAt, note: d.note }
        : null,
      match,
      system,
      open: match ? match.pgOnly.length + match.sysOnly.length : 0,
    });
  }
  return out;
}
