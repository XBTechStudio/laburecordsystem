import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { TierScoring } from "@/lib/tiers";

/** SQL for the tier score (0–100), the same formula as scorePlayer(). */
export function scoreSql(s: TierScoring) {
  const w = s.weightAmount + s.weightCount + s.weightAvg || 1;
  return Prisma.sql`((LEAST(p.depositTotal / ${s.amountFull}, 1) * ${s.weightAmount}
    + LEAST(p.depositCount / ${s.countFull}, 1) * ${s.weightCount}
    + LEAST(IF(p.depositCount > 0, p.depositTotal / p.depositCount, 0) / ${s.avgFull}, 1) * ${s.weightAvg}) / ${w} * 100)`;
}

/** Score bounds for the tier at `rank` (0 = best; tiers.length = the lowest, unnamed group). */
export function tierBounds(s: TierScoring, rank: number) {
  const sorted = [...s.tiers].sort((a, b) => b.minScore - a.minScore);
  const lo = rank < sorted.length ? sorted[rank].minScore : -1;
  const hi = rank === 0 ? 1e9 : sorted[rank - 1]?.minScore ?? 1e9;
  return { lo, hi };
}

export type PlayerRow = {
  id: number;
  brandId: number;
  username: string;
  name: string | null;
  phone: string | null;
  note: string | null;
  status: string;
  depositTotal: number;
  depositCount: number;
  withdrawTotal: number;
  withdrawCount: number;
  firstDepositAt: Date | null;
  lastDepositAt: Date | null;
  assignedToId: number | null;
  assignedName: string | null;
  score: number;
};

export type PlayerFilter = {
  brandIds: number[];
  q?: string;
  tierRank?: number;
  assigned?: "me" | "none" | number;
  meId?: number;
  status?: "ACTIVE" | "SUSPENDED" | "BANNED";
  /** Only players whose last deposit is older than / newer than these instants. */
  idleBefore?: Date;
  idleAfter?: Date;
  hasDeposit?: boolean;
  /** true = someone contacted them after their last deposit; false = nobody has yet. */
  contacted?: boolean;
  /** Contacted after their last deposit, but the latest contact is older than this: due a second follow-up. */
  refollowBefore?: Date;
  sort?: PlayerSort;
  /** Lowest first, for the column sorts (deposit … net). */
  asc?: boolean;
  limit: number;
  offset: number;
};

export const PLAYER_SORTS = ["value", "deposit", "count", "avg", "withdraw", "wcount", "net", "recent", "idle", "newest", "brand", "username", "followup"] as const;
export type PlayerSort = (typeof PLAYER_SORTS)[number];
export const playerSort = (v: string | undefined) => PLAYER_SORTS.find((s) => s === v);

export async function queryPlayers(s: TierScoring, f: PlayerFilter): Promise<{ rows: PlayerRow[]; total: number }> {
  if (!f.brandIds.length) return { rows: [], total: 0 };
  const score = scoreSql(s);
  const where: Prisma.Sql[] = [Prisma.sql`p.brandId IN (${Prisma.join(f.brandIds)})`];
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "")}%`;
    const digits = f.q.replace(/\D/g, "");
    where.push(
      digits.length >= 5
        ? Prisma.sql`(p.username LIKE ${like} OR p.name LIKE ${like} OR p.phoneKey LIKE ${`%${digits.slice(-9)}%`})`
        : Prisma.sql`(p.username LIKE ${like} OR p.name LIKE ${like})`,
    );
  }
  if (f.tierRank != null) {
    const { lo, hi } = tierBounds(s, f.tierRank);
    where.push(Prisma.sql`${score} >= ${lo} AND ${score} < ${hi}`);
  }
  if (f.assigned === "me" && f.meId) where.push(Prisma.sql`p.assignedToId = ${f.meId}`);
  else if (f.assigned === "none") where.push(Prisma.sql`p.assignedToId IS NULL`);
  else if (typeof f.assigned === "number") where.push(Prisma.sql`p.assignedToId = ${f.assigned}`);
  if (f.status) where.push(Prisma.sql`p.status = ${f.status}`);
  if (f.hasDeposit) where.push(Prisma.sql`p.depositCount > 0`);
  if (f.contacted != null) {
    const ex = Prisma.sql`EXISTS (SELECT 1 FROM \`ContactLog\` c WHERE c.playerId = p.id AND c.contactedAt > p.lastDepositAt)`;
    where.push(f.contacted ? ex : Prisma.sql`NOT ${ex}`);
  }
  if (f.refollowBefore) {
    where.push(Prisma.sql`EXISTS (SELECT 1 FROM \`ContactLog\` c WHERE c.playerId = p.id AND c.contactedAt > p.lastDepositAt)`);
    where.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM \`ContactLog\` c WHERE c.playerId = p.id AND c.contactedAt >= ${f.refollowBefore})`);
  }
  if (f.idleBefore) where.push(Prisma.sql`p.lastDepositAt < ${f.idleBefore}`);
  if (f.idleAfter) where.push(Prisma.sql`p.lastDepositAt >= ${f.idleAfter}`);
  const cond = Prisma.join(where, " AND ");

  const dir = Prisma.raw(f.asc ? "ASC" : "DESC");
  const order = {
    value: Prisma.sql`score ${dir}, p.depositTotal ${dir}`,
    deposit: Prisma.sql`p.depositTotal ${dir}`,
    count: Prisma.sql`p.depositCount ${dir}, p.depositTotal ${dir}`,
    avg: Prisma.sql`IF(p.depositCount > 0, p.depositTotal / p.depositCount, 0) ${dir}`,
    withdraw: Prisma.sql`p.withdrawTotal ${dir}`,
    wcount: Prisma.sql`p.withdrawCount ${dir}, p.withdrawTotal ${dir}`,
    net: Prisma.sql`(p.depositTotal - p.withdrawTotal) ${dir}`,
    recent: Prisma.sql`p.lastDepositAt IS NULL, p.lastDepositAt DESC`,
    idle: Prisma.sql`p.lastDepositAt IS NULL, p.lastDepositAt ASC`,
    newest: Prisma.sql`p.id DESC`,
    brand: Prisma.sql`(SELECT b.name FROM \`Brand\` b WHERE b.id = p.brandId) ${dir}, score DESC`,
    username: Prisma.sql`p.username ${dir}`,
    // Latest contact ever; players never contacted sort as the oldest.
    followup: Prisma.sql`(SELECT MAX(c.contactedAt) FROM \`ContactLog\` c WHERE c.playerId = p.id) ${dir}, score DESC`,
  }[f.sort ?? "value"];

  const [rows, total] = await Promise.all([
    prisma.$queryRaw<PlayerRow[]>`
      SELECT p.id, p.brandId, p.username, p.name, p.phone, p.note, p.status, p.depositTotal, p.depositCount, p.withdrawTotal, p.withdrawCount,
             p.firstDepositAt, p.lastDepositAt, p.assignedToId, u.name AS assignedName, ${score} AS score
      FROM \`Player\` p LEFT JOIN \`User\` u ON u.id = p.assignedToId
      WHERE ${cond} ORDER BY ${order} LIMIT ${f.limit} OFFSET ${f.offset}`,
    prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM \`Player\` p WHERE ${cond}`,
  ]);
  return {
    rows: rows.map((r) => ({
      ...r,
      depositTotal: Number(r.depositTotal),
      withdrawTotal: Number(r.withdrawTotal),
      depositCount: Number(r.depositCount),
      withdrawCount: Number(r.withdrawCount),
      score: Math.round(Number(r.score)),
    })),
    total: Number(total[0]?.c ?? 0),
  };
}

export const statusParam = (v: string | undefined) => (v === "ACTIVE" || v === "SUSPENDED" || v === "BANNED" ? v : undefined);

export function tierName(s: TierScoring, score: number) {
  const sorted = [...s.tiers].sort((a, b) => b.minScore - a.minScore);
  const i = sorted.findIndex((t) => score >= t.minScore);
  return { name: i >= 0 ? sorted[i].name : s.lowestName, rank: i >= 0 ? i : sorted.length };
}

export function tierOptions(s: TierScoring) {
  const sorted = [...s.tiers].sort((a, b) => b.minScore - a.minScore);
  return [...sorted.map((t, i) => ({ rank: i, name: t.name })), { rank: sorted.length, name: s.lowestName }];
}
