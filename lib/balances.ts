import "server-only";

import { Prisma } from "@prisma/client";
import { addDays, dayStart, type Range } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { n } from "@/lib/format";

const EPOCH = new Date("1970-01-01T00:00:00Z");

export type Balance = { opening: number; deposits: number; withdrawals: number; fees: number; moves: number; expected: number };

/**
 * What each PG/bank account should hold at `at`, from its opening balance and everything recorded since:
 * + deposits − withdrawals − deposit fees (the account's fee rate) ± manual moves.
 */
export async function expectedBalances(at: Date = new Date(), channelIds?: number[]) {
  const only = channelIds?.length ? Prisma.sql`AND c.id IN (${Prisma.join(channelIds)})` : Prisma.empty;
  const [txns, moves, channels] = await Promise.all([
    prisma.$queryRaw<{ id: number; dep: unknown; wd: unknown; fee: unknown }[]>`
      SELECT c.id,
        SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount ELSE 0 END) AS dep,
        SUM(CASE WHEN t.type = 'WITHDRAW' THEN t.amount ELSE 0 END) AS wd,
        SUM(CASE WHEN t.type = 'DEPOSIT' AND c.feeAtSettlement = 0 THEN t.amount * c.feePercent / 100 + c.feeFixed ELSE 0 END) AS fee
      FROM \`PayChannel\` c JOIN \`Txn\` t ON t.channelId = c.id AND t.txnAt >= COALESCE(c.openingAt, ${EPOCH}) AND t.txnAt <= ${at}
      WHERE 1 = 1 ${only}
      GROUP BY c.id`,
    prisma.$queryRaw<{ id: number; amt: unknown }[]>`
      SELECT c.id, SUM(m.amount) AS amt
      FROM \`PayChannel\` c JOIN \`ChannelMove\` m ON m.channelId = c.id AND m.at >= COALESCE(c.openingAt, ${EPOCH}) AND m.at <= ${at}
      WHERE 1 = 1 ${only}
      GROUP BY c.id`,
    prisma.payChannel.findMany({ where: channelIds?.length ? { id: { in: channelIds } } : {} }),
  ]);
  const out = new Map<number, Balance>();
  for (const c of channels) {
    const opening = c.openingAt && c.openingAt > at ? 0 : n(c.openingBalance);
    out.set(c.id, { opening, deposits: 0, withdrawals: 0, fees: 0, moves: 0, expected: opening });
  }
  for (const t of txns) {
    const b = out.get(t.id);
    if (!b) continue;
    b.deposits = n(t.dep as number);
    b.withdrawals = n(t.wd as number);
    b.fees = n(t.fee as number);
  }
  for (const m of moves) {
    const b = out.get(m.id);
    if (b) b.moves = n(m.amt as number);
  }
  for (const b of out.values()) b.expected = Math.round((b.opening + b.deposits - b.withdrawals - b.fees + b.moves) * 100) / 100;
  return out;
}

export type LedgerDay = {
  day: string;
  opening: number;
  deposits: number;
  depositCount: number;
  withdrawals: number;
  withdrawCount: number;
  fees: number;
  moves: number;
  closing: number;
  /** closing − opening: the day's net change, what PG pages show as "remaining" for the day. */
  change: number;
};

/** One account, day by day (Malaysia days), with running balances. */
export async function ledger(channelId: number, r: Range): Promise<LedgerDay[]> {
  const t0 = dayStart(r.from);
  const t1 = dayStart(addDays(r.to, 1));
  const before = (await expectedBalances(new Date(t0.getTime() - 1), [channelId])).get(channelId)?.expected ?? 0;
  const [txns, moves] = await Promise.all([
    prisma.$queryRaw<{ d: string; type: string; amt: unknown; cnt: bigint; fee: unknown }[]>`
      SELECT DATE_FORMAT(DATE_ADD(t.txnAt, INTERVAL 8 HOUR), '%Y-%m-%d') AS d, t.type, SUM(t.amount) AS amt, COUNT(*) AS cnt,
        SUM(CASE WHEN t.type = 'DEPOSIT' AND c.feeAtSettlement = 0 THEN t.amount * c.feePercent / 100 + c.feeFixed ELSE 0 END) AS fee
      FROM \`Txn\` t JOIN \`PayChannel\` c ON c.id = t.channelId
      WHERE t.channelId = ${channelId} AND t.txnAt >= ${t0} AND t.txnAt < ${t1} AND t.txnAt >= COALESCE(c.openingAt, ${EPOCH})
      GROUP BY d, t.type`,
    prisma.$queryRaw<{ d: string; amt: unknown }[]>`
      SELECT DATE_FORMAT(DATE_ADD(m.at, INTERVAL 8 HOUR), '%Y-%m-%d') AS d, SUM(m.amount) AS amt
      FROM \`ChannelMove\` m JOIN \`PayChannel\` c ON c.id = m.channelId
      WHERE m.channelId = ${channelId} AND m.at >= ${t0} AND m.at < ${t1} AND m.at >= COALESCE(c.openingAt, ${EPOCH})
      GROUP BY d`,
  ]);
  const days: LedgerDay[] = [];
  let running = before;
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) {
    const dep = txns.find((x) => x.d === d && x.type === "DEPOSIT");
    const wd = txns.find((x) => x.d === d && x.type === "WITHDRAW");
    const mv = moves.find((x) => x.d === d);
    const row: LedgerDay = {
      day: d,
      opening: running,
      deposits: n(dep?.amt as number),
      depositCount: Number(dep?.cnt ?? 0),
      withdrawals: n(wd?.amt as number),
      withdrawCount: Number(wd?.cnt ?? 0),
      fees: n(dep?.fee as number),
      moves: n(mv?.amt as number),
      closing: 0,
      change: 0,
    };
    row.closing = Math.round((row.opening + row.deposits - row.withdrawals - row.fees + row.moves) * 100) / 100;
    row.change = Math.round((row.closing - row.opening) * 100) / 100;
    running = row.closing;
    days.push(row);
  }
  return days;
}
