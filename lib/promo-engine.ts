import "server-only";

// Promotion tracking: after deposits change, works out each player's progress towards every tracked
// promotion, records the bonuses they qualify for and raises alerts for CS (close to a tier, bonus ready,
// bonus about to expire, recalled player, player to follow up again).

import { Prisma, type AlertKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { n } from "@/lib/format";
import { clip, inCampaign, nextPeriod, periodAt, type Campaign, type Period, type PeriodOpts } from "@/lib/promo-period";
import { isNear, readRule, tierBonus, tierGap, tierMet, tierShare, type PromoRule } from "@/lib/promo-rule";
import { getSettings, type Settings } from "@/lib/settings";
import { scorePlayer } from "@/lib/tiers";

/** Numbers an alert shows; the text is put together where it's displayed, in the reader's language. */
export type AlertData = {
  promo?: string;
  tier?: number;
  tiers?: number;
  amount?: number;
  count?: number;
  target?: { amount: number; count: number };
  gap?: { amount: number; count: number };
  basis?: PromoRule["basis"];
  minEach?: number;
  bonus?: number;
  payNext?: boolean;
  expiresAt?: string | null;
  deposit?: number;
  depositAt?: string;
  contactAt?: string;
  channel?: string;
};

type Tracked = { id: number; brandId: number; name: string; rule: PromoRule; c: Campaign };
type PlayerRow = { id: number; brandId: number; assignedToId: number | null; depositTotal: Prisma.Decimal; depositCount: number };

const DAY = 86400_000;
const chunks = <T,>(a: T[], size: number) => Array.from({ length: Math.ceil(a.length / size) }, (_, i) => a.slice(i * size, i * size + size));
const opts = (s: Settings): PeriodOpts => ({ dayStartHour: s.alerts.dayStartHour, weekStartDay: s.alerts.weekStartDay });
const forStaff = (s: Settings, assignedToId: number | null) => (s.alerts.target === "owner" ? assignedToId : null);
const json = (d: AlertData) => JSON.parse(JSON.stringify(d)) as Prisma.InputJsonValue;

async function trackedPromos(brandIds: number[]): Promise<Tracked[]> {
  if (!brandIds.length) return [];
  const rows = await prisma.promotion.findMany({ where: { active: true, brandId: { in: brandIds } } });
  return rows.flatMap((p) => {
    const rule = readRule(p.rule);
    return rule && rule.tiers.length ? [{ id: p.id, brandId: p.brandId, name: p.name, rule, c: { startDay: p.startDay, endDay: p.endDay } }] : [];
  });
}

/** When a bonus for this period can be claimed, and until when. */
function awardTimes(p: Tracked, period: Period, o: PeriodOpts, now: Date) {
  const payPeriod = p.rule.payNext ? nextPeriod(period, p.rule.period, o, p.c) : period;
  const eligibleAt = p.rule.payNext ? period.end : now < period.end ? now : new Date(period.end.getTime() - 1000);
  const e = p.rule.expiry;
  const expiresAt = e.kind === "period" ? payPeriod.end : e.kind === "hours" && e.hours > 0 ? new Date(eligibleAt.getTime() + e.hours * 3600_000) : null;
  return { eligibleAt, expiresAt };
}

type Candidate = { p: Tracked; period: Period; tier: number; share: number; data: AlertData };

/**
 * Recomputes progress, bonuses and "close to a tier" alerts for these players.
 * `times` = moments of deposits that were added, changed or removed (their periods are recounted too).
 */
export async function trackPlayers(playerIds: number[], times: Date[] = []) {
  const ids = [...new Set(playerIds)].filter(Boolean);
  if (!ids.length) return;
  const settings = await getSettings();
  const o = opts(settings);
  const now = new Date();
  for (const part of chunks(ids, 500)) {
    const players = await prisma.player.findMany({
      where: { id: { in: part } },
      select: { id: true, brandId: true, assignedToId: true, depositTotal: true, depositCount: true },
    });
    const promos = await trackedPromos([...new Set(players.map((p) => p.brandId))]);
    const candidates = new Map<number, Candidate[]>();
    for (const p of promos) {
      const mine = players.filter((pl) => pl.brandId === p.brandId && tierAllowed(settings, p.rule, pl));
      if (!mine.length) continue;
      const periods = new Map<string, Period>();
      for (const at of [now, ...times]) {
        const per = periodAt(at, p.rule.period, o, p.c);
        if (per.end.getTime() < now.getTime() - 62 * DAY) continue;
        periods.set(per.key, per);
      }
      for (const per of periods.values()) {
        const found = await recount(p, per, mine, o, now);
        for (const c of found) candidates.set(c.playerId, [...(candidates.get(c.playerId) ?? []), c.cand]);
      }
    }
    await syncNearAlerts(settings, players, promos, candidates, now);
    await syncRecalls(settings, part, now);
  }
}

/** Every player tracked by this promotion in its current period, e.g. after its rule was changed. */
export async function trackPromotion(promotionId: number) {
  const promo = await prisma.promotion.findUnique({ where: { id: promotionId } });
  if (!promo) return;
  const settings = await getSettings();
  const o = opts(settings);
  const rule = readRule(promo.rule);
  const c = { startDay: promo.startDay, endDay: promo.endDay };
  const now = new Date();
  const current = periodAt(now, rule?.period ?? "day", o, c);
  const range = clip(current, o, c);
  const [deposited, existing] = await Promise.all([
    prisma.txn.findMany({ where: { brandId: promo.brandId, type: "DEPOSIT", txnAt: { gte: range.start, lt: range.end } }, select: { playerId: true }, distinct: ["playerId"] }),
    prisma.promoProgress.findMany({ where: { promotionId }, select: { playerId: true }, distinct: ["playerId"] }),
  ]);
  const ids = [...new Set([...deposited, ...existing].map((r) => r.playerId))];
  // A rule that no longer applies: clear what it had raised.
  if (!rule || !rule.tiers.length || !promo.active) {
    await prisma.alert.updateMany({ where: { promotionId, doneAt: null }, data: { doneAt: now, outcome: "auto" } });
  }
  await trackPlayers(ids, []);
}

function tierAllowed(s: Settings, rule: PromoRule, pl: PlayerRow) {
  if (!rule.playerTiers.length) return true;
  return rule.playerTiers.includes(scorePlayer(s.tierScoring, n(pl.depositTotal), pl.depositCount).tier);
}

/** Recounts one period of one promotion for these players; returns who is close to their next tier. */
async function recount(p: Tracked, per: Period, players: PlayerRow[], o: PeriodOpts, now: Date) {
  const out: { playerId: number; cand: Candidate }[] = [];
  const range = clip(per, o, p.c);
  const ids = players.map((pl) => pl.id);
  const sums = new Map<number, { amount: number; count: number }>();
  if (range.start < range.end) {
    const rows = await prisma.$queryRaw<{ playerId: number; amt: unknown; cnt: unknown }[]>`
      SELECT playerId, SUM(amount) AS amt, SUM(amount >= ${p.rule.minEach}) AS cnt FROM \`Txn\`
      WHERE type = 'DEPOSIT' AND playerId IN (${Prisma.join(ids)}) AND txnAt >= ${range.start} AND txnAt < ${range.end}
      GROUP BY playerId`;
    for (const r of rows) sums.set(r.playerId, { amount: n(r.amt as number), count: Number(r.cnt) });
  }
  const [progress, awards] = await Promise.all([
    prisma.promoProgress.findMany({ where: { promotionId: p.id, periodKey: per.key, playerId: { in: ids } } }),
    prisma.promoAward.findMany({ where: { promotionId: p.id, periodKey: per.key, playerId: { in: ids } } }),
  ]);
  const prog = new Map(progress.map((r) => [r.playerId, r]));
  const open = per.end > now && inCampaign(now, o, p.c);
  const { tiers } = p.rule;
  const newRows: Prisma.PromoProgressCreateManyInput[] = [];

  for (const pl of players) {
    const s = sums.get(pl.id) ?? { amount: 0, count: 0 };
    const row = prog.get(pl.id);
    const met = tiers.map((t, i) => (tierMet(p.rule, t, s.amount, s.count) ? i : -1)).filter((i) => i >= 0);
    if (!row && s.amount === 0 && !awards.some((a) => a.playerId === pl.id)) continue;
    if (!row) newRows.push({ promotionId: p.id, playerId: pl.id, brandId: pl.brandId, periodKey: per.key, periodEnd: per.end, amount: s.amount, count: s.count, reached: met.length });
    else if (n(row.amount) !== s.amount || row.count !== s.count || row.reached !== met.length || row.periodEnd.getTime() !== per.end.getTime())
      await prisma.promoProgress.update({ where: { id: row.id }, data: { amount: s.amount, count: s.count, reached: met.length, periodEnd: per.end } });

    // Bonuses: every tier reached when they stack, otherwise only the highest.
    const want = new Set(p.rule.stack ? met : met.length ? [met[met.length - 1]] : []);
    const have = awards.filter((a) => a.playerId === pl.id);
    for (const a of have) {
      if (!want.has(a.tier) && !a.claimedAt) {
        await prisma.alert.updateMany({ where: { awardId: a.id, doneAt: null }, data: { doneAt: now, outcome: "auto" } });
        await prisma.promoAward.delete({ where: { id: a.id } });
      } else if (want.has(a.tier) && !a.claimedAt && tiers[a.tier] && tierBonus(tiers[a.tier], s.amount) !== n(a.bonus)) {
        await prisma.promoAward.update({ where: { id: a.id }, data: { bonus: tierBonus(tiers[a.tier], s.amount) } });
      }
    }
    for (const tier of want) {
      if (have.some((a) => a.tier === tier)) continue;
      const { eligibleAt, expiresAt } = awardTimes(p, per, o, now);
      const award = await prisma.promoAward.create({
        data: { promotionId: p.id, playerId: pl.id, brandId: pl.brandId, periodKey: per.key, tier, bonus: tierBonus(tiers[tier], s.amount), eligibleAt, expiresAt },
      });
      // A player who reached the tier no longer needs the "almost there" alert for it.
      await prisma.alert.updateMany({ where: { key: nearKey(p.id, pl.id, per.key, tier), doneAt: null }, data: { doneAt: now, outcome: "auto" } });
      if (p.rule.notifyEligible && eligibleAt <= now && (!expiresAt || expiresAt > now)) {
        await raise("ELIGIBLE", `elig:${award.id}`, pl, p.id, per.key, { awardId: award.id, until: expiresAt }, eligibleData(p, award.tier, n(award.bonus), expiresAt));
      }
    }

    // Close to the next tier?
    if (!open) continue;
    const next = tiers.findIndex((t) => !tierMet(p.rule, t, s.amount, s.count));
    if (next < 0 || !isNear(p.rule, tiers[next], s.amount, s.count)) continue;
    const t = tiers[next];
    out.push({
      playerId: pl.id,
      cand: {
        p,
        period: per,
        tier: next,
        share: tierShare(p.rule, t, s.amount, s.count),
        data: {
          promo: p.name,
          tier: next,
          tiers: tiers.length,
          amount: s.amount,
          count: s.count,
          target: { amount: t.amount, count: t.count },
          gap: tierGap(p.rule, t, s.amount, s.count),
          basis: p.rule.basis,
          minEach: p.rule.minEach,
          bonus: tierBonus(t, Math.max(s.amount, t.amount)),
          payNext: p.rule.payNext,
        },
      },
    });
  }
  if (newRows.length) await prisma.promoProgress.createMany({ data: newRows, skipDuplicates: true });
  return out;
}

const nearKey = (promoId: number, playerId: number, periodKey: string, tier: number) => `near:${promoId}:${playerId}:${periodKey}:${tier}`;

function eligibleData(p: Tracked, tier: number, bonus: number, expiresAt: Date | null): AlertData {
  return { promo: p.name, tier, tiers: p.rule.tiers.length, bonus, payNext: p.rule.payNext, expiresAt: expiresAt?.toISOString() ?? null };
}

/** Creates an alert once per key. */
async function raise(
  kind: AlertKind,
  key: string,
  pl: { id: number; brandId: number; assignedToId: number | null },
  promotionId: number | null,
  periodKey: string | null,
  extra: { awardId?: number; contactId?: number; until?: Date | null; staffId?: number | null },
  data: AlertData,
) {
  const s = await getSettings();
  await prisma.alert.createMany({
    data: [
      {
        key,
        kind,
        brandId: pl.brandId,
        playerId: pl.id,
        promotionId,
        periodKey,
        awardId: extra.awardId ?? null,
        contactId: extra.contactId ?? null,
        staffId: extra.staffId !== undefined ? extra.staffId : forStaff(s, pl.assignedToId),
        until: extra.until ?? null,
        data: json(data),
        raisedAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
}

/** Keeps "close to a tier" alerts in line with the players' progress. */
async function syncNearAlerts(s: Settings, players: PlayerRow[], promos: Tracked[], candidates: Map<number, Candidate[]>, now: Date) {
  if (!promos.length) return;
  const byId = new Map(players.map((p) => [p.id, p]));
  const existing = await prisma.alert.findMany({ where: { kind: "NEAR", playerId: { in: players.map((p) => p.id) }, OR: [{ until: null }, { until: { gt: now } }] } });
  const tracked = new Set(promos.map((p) => p.id));
  const wanted = new Set<string>();
  for (const [playerId, list] of candidates) {
    const pl = byId.get(playerId)!;
    const pickList = s.alerts.notify === "nearest" ? [list.reduce((a, b) => (b.share > a.share || (b.share === a.share && (b.data.bonus ?? 0) > (a.data.bonus ?? 0)) ? b : a))] : list;
    for (const c of pickList) {
      const key = nearKey(c.p.id, playerId, c.period.key, c.tier);
      wanted.add(key);
      const a = existing.find((e) => e.key === key);
      if (!a) {
        await raise("NEAR", key, pl, c.p.id, c.period.key, { until: c.period.end }, c.data);
        continue;
      }
      const repeat = c.p.rule.remind.repeatHours;
      const reopen = a.doneAt && (a.outcome === "auto" || (repeat > 0 && a.doneAt.getTime() < now.getTime() - repeat * 3600_000));
      await prisma.alert.update({
        where: { id: a.id },
        data: { data: json(c.data), ...(reopen ? { doneAt: null, doneById: null, outcome: null, raisedAt: now, staffId: forStaff(s, pl.assignedToId) } : {}) },
      });
    }
  }
  // Open alerts that no longer apply (tier reached, deposit removed, another promotion is now closer).
  const stale = existing.filter((a) => !a.doneAt && !wanted.has(a.key) && a.promotionId && tracked.has(a.promotionId)).map((a) => a.id);
  if (stale.length) await prisma.alert.updateMany({ where: { id: { in: stale } }, data: { doneAt: now, outcome: "auto" } });
}

/** Marks contacts whose player deposited again within the return window, and tells the CS who made the contact. */
async function syncRecalls(s: Settings, playerIds: number[], now: Date) {
  const since = new Date(now.getTime() - (s.recallDays + 62) * DAY);
  const contacts = await prisma.contactLog.findMany({
    where: { playerId: { in: playerIds }, contactedAt: { gte: since } },
    include: { player: { select: { id: true, brandId: true, assignedToId: true } } },
    orderBy: { contactedAt: "asc" },
  });
  if (!contacts.length) return;
  const deposits = await prisma.txn.findMany({
    where: { playerId: { in: [...new Set(contacts.map((c) => c.playerId))] }, type: "DEPOSIT", txnAt: { gte: since } },
    select: { playerId: true, amount: true, txnAt: true },
    orderBy: { txnAt: "asc" },
  });
  for (const c of contacts) {
    const until = c.contactedAt.getTime() + s.recallDays * DAY;
    const d = deposits.find((x) => x.playerId === c.playerId && x.txnAt > c.contactedAt && x.txnAt.getTime() <= until && n(x.amount) >= s.recallMinAmount);
    const same = d ? c.recalledAt?.getTime() === d.txnAt.getTime() && n(c.recallAmount) === n(d.amount) : !c.recalledAt;
    if (same) continue;
    await prisma.contactLog.update({ where: { id: c.id }, data: { recalledAt: d?.txnAt ?? null, recallAmount: d ? d.amount : null } });
    if (d && !c.recalledAt && s.alerts.recall) {
      await raise("RECALLED", `recall:${c.id}`, c.player, null, null, { contactId: c.id, staffId: c.staffId }, {
        deposit: n(d.amount),
        depositAt: d.txnAt.toISOString(),
        contactAt: c.contactedAt.toISOString(),
        channel: c.channel,
      });
    }
  }
  // Anyone who deposited after their last contact no longer needs following up again.
  const last = new Map<number, Date>();
  for (const c of contacts) last.set(c.playerId, c.contactedAt);
  const back = [...last].filter(([pid, at]) => deposits.some((x) => x.playerId === pid && x.txnAt > at)).map(([pid]) => pid);
  if (back.length) await prisma.alert.updateMany({ where: { kind: "REFOLLOW", playerId: { in: back }, doneAt: null }, data: { doneAt: now, outcome: "auto" } });
}

/** Links claims to the bonuses they pay out (oldest unclaimed first), closing the bonus alerts. */
export async function linkClaims(where: Prisma.PromoClaimWhereInput) {
  const claims = await prisma.promoClaim.findMany({ where, orderBy: { claimedAt: "asc" } });
  if (!claims.length) return;
  const linked = new Set((await prisma.promoAward.findMany({ where: { claimId: { in: claims.map((c) => c.id) } }, select: { claimId: true } })).map((a) => a.claimId));
  for (const c of claims) {
    if (linked.has(c.id)) continue;
    const a = await prisma.promoAward.findFirst({
      where: { promotionId: c.promotionId, playerId: c.playerId, claimedAt: null, eligibleAt: { lte: new Date(c.claimedAt.getTime() + DAY) } },
      orderBy: [{ eligibleAt: "asc" }, { tier: "asc" }],
    });
    if (!a) continue;
    await prisma.promoAward.update({ where: { id: a.id }, data: { claimedAt: c.claimedAt, claimId: c.id } });
    await prisma.alert.updateMany({ where: { awardId: a.id, doneAt: null }, data: { doneAt: new Date(), outcome: "claimed", doneById: c.createdById } });
  }
}

/** Before claims are deleted: their bonuses become unclaimed again. */
export async function unlinkClaims(where: Prisma.PromoClaimWhereInput) {
  const ids = (await prisma.promoClaim.findMany({ where, select: { id: true } })).map((c) => c.id);
  if (!ids.length) return;
  const awards = (await prisma.promoAward.findMany({ where: { claimId: { in: ids } }, select: { id: true } })).map((a) => a.id);
  await prisma.promoAward.updateMany({ where: { id: { in: awards } }, data: { claimId: null, claimedAt: null } });
  // The bonus is open again, so is its alert (unless its time is up; the tick closes those).
  await prisma.alert.updateMany({ where: { awardId: { in: awards }, outcome: "claimed" }, data: { doneAt: null, doneById: null, outcome: null } });
}

/**
 * Time-based work: bonuses that become claimable (next-period ones), bonuses about to expire,
 * alerts whose time is up, and players to follow up again. Runs at most once a minute.
 */
export async function alertTick(force = false) {
  const g = globalThis as { alertTickAt?: number; alertTickBusy?: boolean };
  if (g.alertTickBusy || (!force && g.alertTickAt && Date.now() - g.alertTickAt < 60_000)) return;
  g.alertTickBusy = true;
  g.alertTickAt = Date.now();
  try {
    const s = await getSettings();
    const now = new Date();
    const promos = await prisma.promotion.findMany({ where: { active: true } });
    const rules = new Map(promos.flatMap((p) => (readRule(p.rule) ? [[p.id, { p, rule: readRule(p.rule)! }] as const] : [])));

    if (rules.size) {
      const awards = await prisma.promoAward.findMany({
        where: { promotionId: { in: [...rules.keys()] }, claimedAt: null, eligibleAt: { lte: now, gte: new Date(now.getTime() - 40 * DAY) }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        include: { player: { select: { id: true, brandId: true, assignedToId: true } } },
      });
      for (const a of awards) {
        const { p, rule } = rules.get(a.promotionId)!;
        const tr = { id: p.id, brandId: p.brandId, name: p.name, rule, c: { startDay: p.startDay, endDay: p.endDay } };
        const data = eligibleData(tr, a.tier, n(a.bonus), a.expiresAt);
        if (rule.notifyEligible) await raise("ELIGIBLE", `elig:${a.id}`, a.player, p.id, a.periodKey, { awardId: a.id, until: a.expiresAt }, data);
        if (a.expiresAt && rule.expiry.warnHours > 0 && a.expiresAt.getTime() - now.getTime() <= rule.expiry.warnHours * 3600_000) {
          await raise("EXPIRING", `exp:${a.id}`, a.player, p.id, a.periodKey, { awardId: a.id, until: a.expiresAt }, data);
        }
      }
    }

    // Time is up: the period ended or the bonus expired.
    await prisma.alert.updateMany({ where: { doneAt: null, until: { lte: now } }, data: { doneAt: now, outcome: "auto" } });
    // Promotions that were ended or no longer tracked.
    const live = [...rules.keys()];
    await prisma.alert.updateMany({ where: { doneAt: null, promotionId: { not: null, ...(live.length ? { notIn: live } : {}) } }, data: { doneAt: now, outcome: "auto" } });

    if (s.refollowDays > 0) await refollow(s, now);
  } catch (e) {
    console.error("alert tick failed", e);
  } finally {
    g.alertTickBusy = false;
  }
}

/** Last contact is `refollowDays` old and the player still hasn't deposited: one reminder per contact. */
async function refollow(s: Settings, now: Date) {
  const due = new Date(now.getTime() - s.refollowDays * DAY);
  const oldest = new Date(due.getTime() - 14 * DAY);
  const rows = await prisma.$queryRaw<{ id: number; playerId: number; staffId: number; contactedAt: Date; channel: string; brandId: number; assignedToId: number | null }[]>`
    SELECT c.id, c.playerId, c.staffId, c.contactedAt, c.channel, p.brandId, p.assignedToId
    FROM \`ContactLog\` c JOIN \`Player\` p ON p.id = c.playerId
    WHERE c.contactedAt <= ${due} AND c.contactedAt >= ${oldest}
      AND c.contactedAt = (SELECT MAX(c2.contactedAt) FROM \`ContactLog\` c2 WHERE c2.playerId = c.playerId)
      AND (p.lastDepositAt IS NULL OR p.lastDepositAt < c.contactedAt)`;
  for (const r of rows) {
    await raise("REFOLLOW", `refollow:${r.id}`, { id: r.playerId, brandId: r.brandId, assignedToId: r.assignedToId }, null, null, { contactId: r.id, staffId: s.alerts.target === "team" ? null : (r.assignedToId ?? r.staffId) }, {
      contactAt: r.contactedAt.toISOString(),
      channel: r.channel,
    });
  }
}

/** Tracking must never stop a save from going through. */
export async function safely(what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`promotion tracking (${what}) failed`, e);
  }
}
