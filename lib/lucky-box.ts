import "server-only";

// Lucky Box: points a player won on a free game (e.g. Daily FREE) that can't be withdrawn straight away.
// They wait in the box until the player's own play meets the promotion's release rule; then CS is told how much
// to give back on the platform, and records the release here. Balance = IN − RELEASE − EXPIRE.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { n } from "@/lib/format";
import { autoRelease, readBox, type BoxRule } from "@/lib/box-rule";
import { getSettings } from "@/lib/settings";

const DAY = 86400_000;
const r2 = (v: number) => Math.round(v * 100) / 100;

export type BoxPromo = { id: number; brandId: number; name: string; active: boolean; rule: BoxRule };

/** What a release would be: how much, and the play that earned it. */
export type BoxReady = { key: string; amount: number; netWin?: number; deposit: number; at: string; txnId?: number };

export type BoxState = {
  playerId: number;
  promotionId: number;
  brandId: number;
  balance: number;
  stored: number;
  released: number;
  expired: number;
  lastAt: Date;
  /** Release rules count play from here: the last release, or when the box filled up again. */
  since: Date;
  ready: BoxReady | null;
  /** Progress towards the rule while not ready. */
  deposit: number;
  bestNetWin: number;
};

export async function boxPromos(brandIds: number[], activeOnly = true): Promise<BoxPromo[]> {
  if (!brandIds.length) return [];
  const rows = await prisma.promotion.findMany({ where: { brandId: { in: brandIds }, box: { not: Prisma.DbNull }, ...(activeOnly ? { active: true } : {}) } });
  return rows.flatMap((p) => {
    const rule = readBox(p.box);
    return rule ? [{ id: p.id, brandId: p.brandId, name: p.name, active: p.active, rule }] : [];
  });
}

/** Box balances of these players (or of everyone in these promotions), with whether each can be released now. */
export async function boxStates(where: { playerIds?: number[]; promos: BoxPromo[] }): Promise<BoxState[]> {
  const promos = new Map(where.promos.map((p) => [p.id, p]));
  if (!promos.size) return [];
  const entries = await prisma.boxEntry.findMany({
    where: { promotionId: { in: [...promos.keys()] }, ...(where.playerIds ? { playerId: { in: where.playerIds } } : {}) },
    select: { playerId: true, promotionId: true, brandId: true, kind: true, amount: true, at: true },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  const groups = new Map<string, typeof entries>();
  for (const e of entries) {
    const k = `${e.playerId}:${e.promotionId}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }

  const states: BoxState[] = [];
  for (const list of groups.values()) {
    let bal = 0;
    let stored = 0;
    let released = 0;
    let expired = 0;
    let since = list[0].at;
    for (const e of list) {
      const a = n(e.amount);
      if (e.kind === "IN") {
        // Filling an empty box starts the count again.
        if (bal <= 0.005) since = e.at;
        bal += a;
        stored += a;
      } else {
        bal -= a;
        if (e.kind === "RELEASE") released += a;
        else expired += a;
        since = e.at;
      }
    }
    const f = list[0];
    states.push({
      playerId: f.playerId,
      promotionId: f.promotionId,
      brandId: f.brandId,
      balance: r2(bal),
      stored: r2(stored),
      released: r2(released),
      expired: r2(expired),
      lastAt: list[list.length - 1].at,
      since,
      ready: null,
      deposit: 0,
      bestNetWin: 0,
    });
  }

  // Release rules look at the player's deposits and withdrawals after `since`.
  const open = states.filter((s) => s.balance > 0.005);
  if (!open.length) return states;
  const from = new Date(Math.min(...open.map((s) => s.since.getTime())) - 90 * DAY);
  const txns = await prisma.txn.findMany({
    where: { playerId: { in: [...new Set(open.map((s) => s.playerId))] }, txnAt: { gte: from } },
    select: { id: true, playerId: true, type: true, amount: true, txnAt: true },
    orderBy: [{ txnAt: "asc" }, { id: "asc" }],
  });
  const byPlayer = new Map<number, typeof txns>();
  for (const x of txns) byPlayer.set(x.playerId, [...(byPlayer.get(x.playerId) ?? []), x]);

  for (const s of open) {
    const rule = promos.get(s.promotionId)!.rule;
    const mine = byPlayer.get(s.playerId) ?? [];
    const after = mine.filter((x) => x.txnAt > s.since);
    const amount = r2(rule.releaseCap > 0 ? Math.min(rule.releaseCap, s.balance) : s.balance);
    const depositsUntil = (at: Date) => r2(after.filter((x) => x.type === "DEPOSIT" && x.txnAt <= at).reduce((a, x) => a + n(x.amount), 0));
    s.deposit = depositsUntil(new Date(8.64e15));
    if (rule.minNetWin > 0) {
      // Net win of a withdrawal = the withdrawal − deposits since the previous withdrawal (the player's own money doesn't count).
      let prev: Date | null = null;
      for (const x of mine) {
        if (x.type !== "WITHDRAW") continue;
        const dep = mine.filter((d) => d.type === "DEPOSIT" && (!prev || d.txnAt > prev) && d.txnAt <= x.txnAt).reduce((a, d) => a + n(d.amount), 0);
        prev = x.txnAt;
        if (x.txnAt <= s.since) continue;
        const netWin = r2(n(x.amount) - dep);
        s.bestNetWin = Math.max(s.bestNetWin, netWin);
        const depSince = depositsUntil(x.txnAt);
        if (!s.ready && netWin >= rule.minNetWin && (rule.minDeposit <= 0 || depSince >= rule.minDeposit)) {
          s.ready = { key: `w${x.id}`, amount, netWin, deposit: depSince, at: x.txnAt.toISOString(), txnId: x.id };
        }
      }
    } else if (rule.minDeposit > 0 && s.deposit >= rule.minDeposit) {
      const hit = after.filter((x) => x.type === "DEPOSIT").find((x) => depositsUntil(x.txnAt) >= rule.minDeposit)!;
      s.ready = { key: `d${s.since.getTime()}`, amount, deposit: s.deposit, at: hit.txnAt.toISOString() };
    }
  }
  return states;
}

const boxKey = (s: BoxState) => `box:${s.promotionId}:${s.playerId}:${s.ready!.key}`;

/** Raises "can be released" alerts for these players' boxes and closes ones that no longer apply (e.g. the withdrawal was deleted). */
export async function trackBoxes(playerIds: number[]) {
  const ids = [...new Set(playerIds)].filter(Boolean);
  if (!ids.length) return;
  const players = await prisma.player.findMany({ where: { id: { in: ids } }, select: { id: true, brandId: true, assignedToId: true } });
  const promos = await boxPromos([...new Set(players.map((p) => p.brandId))]);
  const now = new Date();
  const existing = await prisma.alert.findMany({ where: { kind: "BOX", playerId: { in: ids }, doneAt: null } });
  const wanted = new Set<string>();
  if (promos.length) {
    const s = await getSettings();
    const byId = new Map(players.map((p) => [p.id, p]));
    const names = new Map(promos.map((p) => [p.id, p]));
    for (const st of await boxStates({ playerIds: ids, promos })) {
      const promo = names.get(st.promotionId)!;
      if (!st.ready || !promo.rule.notify || !autoRelease(promo.rule)) continue;
      const key = boxKey(st);
      wanted.add(key);
      const data = { promo: promo.name, bonus: st.ready.amount, balance: st.balance, netWin: st.ready.netWin, deposit: st.ready.deposit, depositAt: st.ready.at } as Prisma.InputJsonValue;
      const a = existing.find((e) => e.key === key);
      if (a) {
        await prisma.alert.update({ where: { id: a.id }, data: { data } });
        continue;
      }
      const pl = byId.get(st.playerId)!;
      await prisma.alert.createMany({
        data: [{ key, kind: "BOX", brandId: pl.brandId, playerId: pl.id, promotionId: st.promotionId, staffId: s.alerts.target === "owner" ? pl.assignedToId : null, data, raisedAt: now }],
        skipDuplicates: true,
      });
    }
  }
  const stale = existing.filter((a) => !wanted.has(a.key)).map((a) => a.id);
  if (stale.length) await prisma.alert.updateMany({ where: { id: { in: stale } }, data: { doneAt: now, outcome: "auto" } });
}

/** Gives points back: a RELEASE entry plus a claim of the same amount, so it counts as promotion cost everywhere. */
export async function releaseBox(o: { playerId: number; promotionId: number; amount: number; userId: number; note?: string | null }) {
  const promo = await prisma.promotion.findUniqueOrThrow({ where: { id: o.promotionId } });
  const at = new Date();
  const entry = await prisma.$transaction(async (tx) => {
    const claim = await tx.promoClaim.create({ data: { promotionId: o.promotionId, playerId: o.playerId, amount: o.amount, claimedAt: at, createdById: o.userId } });
    return tx.boxEntry.create({
      data: { brandId: promo.brandId, playerId: o.playerId, promotionId: o.promotionId, kind: "RELEASE", amount: o.amount, at, note: o.note ?? null, claimId: claim.id, createdById: o.userId },
    });
  });
  await prisma.alert.updateMany({
    where: { kind: "BOX", playerId: o.playerId, promotionId: o.promotionId, doneAt: null },
    data: { doneAt: at, doneById: o.userId, outcome: "released" },
  });
  await trackBoxes([o.playerId]);
  return entry;
}

/** Points older than the promotion's expiry that were never released run out (oldest first). */
export async function expireBoxes(now = new Date()) {
  const promos = (await boxPromos((await prisma.brand.findMany({ select: { id: true } })).map((b) => b.id))).filter((p) => p.rule.expiryDays > 0);
  const touched = new Set<number>();
  for (const p of promos) {
    const cutoff = new Date(now.getTime() - p.rule.expiryDays * DAY);
    const rows = await prisma.$queryRaw<{ playerId: number; oldIn: unknown; out: unknown }[]>`
      SELECT playerId,
        SUM(CASE WHEN kind = 'IN' AND at < ${cutoff} THEN amount ELSE 0 END) AS oldIn,
        SUM(CASE WHEN kind <> 'IN' THEN amount ELSE 0 END) AS \`out\`
      FROM \`BoxEntry\` WHERE promotionId = ${p.id} GROUP BY playerId`;
    for (const r of rows) {
      const due = r2(n(r.oldIn as number) - n(r.out as number));
      if (due <= 0.005) continue;
      await prisma.boxEntry.create({ data: { brandId: p.brandId, playerId: r.playerId, promotionId: p.id, kind: "EXPIRE", amount: due, at: now, note: `${p.rule.expiryDays}d` } });
      touched.add(r.playerId);
    }
  }
  if (touched.size) await trackBoxes([...touched]);
}
