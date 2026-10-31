import "server-only";

import type { PlatformLink, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addDays } from "@/lib/dates";
import { phoneKey } from "@/lib/format";
import {
  getDailyBets,
  getTransactions,
  getUsers,
  plainText,
  platformDay,
  platformTime,
  referrerOf,
  splitName,
  type Creds,
  type PlatformTxn,
  type PlatformUser,
} from "@/lib/platform-api";
import { refreshPlayerStats } from "@/lib/players";
import { linkClaims, safely, trackPlayers } from "@/lib/promo-engine";
import { open } from "@/lib/secret-box";

// Reads each connected brand's platform on a timer: completed deposits and withdrawals, bonus claims,
// new registrations and daily bets. Everything is matched by the platform's own ids, so reading the
// same stretch twice never adds anything twice.

const HOUR = 3600_000;
/** Most result pages one run may read, so a long catch-up is spread over several runs. */
const PAGE_BUDGET = 120;
/** Transactions are re-read this far back on every run (pending ones complete late)… */
const LOOKBACK = 2 * HOUR;
/** …and once an hour this far back. */
const DEEP_LOOKBACK = 48 * HOUR;

export type ChannelMap = Record<string, { id: number; label: string }>;
export type SyncResult = { txns: number; claims: number; players: number; betDays: number; pages: number; more: boolean };

export const credsOf = (l: Pick<PlatformLink, "apiUrl" | "merchantId" | "accessId" | "tokenEnc">): Creds => ({
  apiUrl: l.apiUrl,
  merchantId: l.merchantId,
  accessId: l.accessId,
  token: open(l.tokenEnc),
});

const json = <T,>(s: string | null | undefined): T | null => {
  try {
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
};

const realPhone = (m?: string) => (m && !m.includes("*") ? m.slice(0, 40) : null);
const when = (s?: string | null) => (s ? new Date(s) : null);

/**
 * Platform members → our player ids, by platform id. A member we haven't linked yet is matched to an
 * existing player by member code (staff type "T11943" or "T11943 Full Name"), otherwise created.
 */
export async function resolvePlayers(brandId: number, users: PlatformUser[]) {
  const byId = new Map(users.filter((u) => u?.id).map((u) => [String(u.id), u]));
  const out = new Map<string, number>();
  if (!byId.size) return { ids: out, created: 0 };
  const known = await prisma.player.findMany({ where: { brandId, extId: { in: [...byId.keys()] } }, select: { id: true, extId: true } });
  for (const k of known) out.set(k.extId!, k.id);

  const rest = [...byId.values()].filter((u) => !out.has(String(u.id)));
  if (!rest.length) return { ids: out, created: 0 };
  const info = rest.map((u) => ({ u, ...splitName(u) }));
  const codes = [...new Set(info.map((i) => i.code))];
  const candidates = await prisma.player.findMany({
    where: { brandId, extId: null, OR: [{ username: { in: codes } }, ...codes.map((c) => ({ username: { startsWith: `${c} ` } }))] },
    select: { id: true, username: true, name: true },
  });
  const taken = new Set<number>();
  const missing: typeof info = [];
  for (const i of info) {
    const lc = i.code.toLowerCase();
    const hit =
      candidates.find((c) => !taken.has(c.id) && c.username.toLowerCase() === lc) ??
      candidates.find((c) => !taken.has(c.id) && c.username.toLowerCase().startsWith(`${lc} `));
    if (!hit) {
      missing.push(i);
      continue;
    }
    taken.add(hit.id);
    const phone = realPhone(i.u.mobile);
    await prisma.player.update({
      where: { id: hit.id },
      data: {
        extId: String(i.u.id),
        ...(hit.name || !i.name ? {} : { name: i.name.slice(0, 120) }),
        ...(i.u.createdDateTime ? { registeredAt: new Date(i.u.createdDateTime) } : {}),
        ...(referrerOf(i.u) ? { referrer: referrerOf(i.u) } : {}),
        ...(phone ? { phone, phoneKey: phoneKey(phone) } : {}),
      },
    });
    out.set(String(i.u.id), hit.id);
  }
  if (missing.length) {
    const row = (i: (typeof info)[number], username: string) => {
      const phone = realPhone(i.u.mobile);
      return {
        brandId,
        username: username.slice(0, 80),
        name: i.name?.slice(0, 120) ?? null,
        extId: String(i.u.id),
        registeredAt: when(i.u.createdDateTime),
        referrer: referrerOf(i.u),
        phone,
        phoneKey: phoneKey(phone),
      };
    };
    await prisma.player.createMany({ data: missing.map((i) => row(i, i.code)), skipDuplicates: true });
    const made = await prisma.player.findMany({ where: { brandId, extId: { in: missing.map((i) => String(i.u.id)) } }, select: { id: true, extId: true } });
    for (const m of made) out.set(m.extId!, m.id);
    // Two members with the same code, or a code already used by another linked player: keep both apart.
    for (const i of missing.filter((i) => !out.has(String(i.u.id)))) {
      const p = await prisma.player.create({ data: row(i, `${i.code} #${i.u.id}`) });
      out.set(String(i.u.id), p.id);
    }
  }
  return { ids: out, created: missing.length };
}

/** Which of our accounts a platform bank / payment method stands for; new ones get an account named "<brand> · <label>". */
async function channelFor(link: PlatformLink & { brand: { name: string; currency: string } }, map: ChannelMap, key: string, label: string) {
  const hit = map[key];
  if (hit && (checked.has(hit.id) || (await prisma.payChannel.count({ where: { id: hit.id } })))) return checked.add(hit.id), hit.id;
  const name = `${link.brand.name} · ${label}`.slice(0, 80);
  const c = await prisma.payChannel.upsert({ where: { name }, create: { name, type: key.startsWith("bank:") ? "BANK" : "PG", currency: link.brand.currency }, update: {} });
  map[key] = { id: c.id, label };
  return c.id;
}

const checked = new Set<number>();

/** "bank:<id>" for the platform's own bank accounts, "m:<method>" for payment gateways. Withdrawals without a bank aren't tied to an account. */
function sourceOf(t: PlatformTxn, d: Record<string, unknown>) {
  if (t.bankId) return { key: `bank:${t.bankId}`, label: String(d.bank || `Bank ${t.bankId}`).slice(0, 60) };
  if (t.type === "DEPOSIT" && d.method) return { key: `m:${String(d.method)}`.slice(0, 80), label: String(d.method).slice(0, 60) };
  return null;
}

async function saveTxns(link: PlatformLink & { brand: { name: string; currency: string } }, map: ChannelMap, rows: PlatformTxn[]) {
  const brandId = link.brandId;
  const money = rows.filter((r) => (r.type === "DEPOSIT" || r.type === "WITHDRAW") && link.syncTxns);
  const bonus = rows.filter((r) => r.type === "BONUS" && link.syncClaims);
  if (!money.length && !bonus.length) return { txns: 0, claims: 0, players: 0 };
  const players = await resolvePlayers(
    brandId,
    [...money, ...bonus].map((r) => r.user!).filter(Boolean),
  );
  let txns = 0;
  let claims = 0;

  if (money.length) {
    const have = new Set(
      (await prisma.txn.findMany({ where: { brandId, ref: { in: money.map((r) => r.id) } }, select: { ref: true } })).map((t) => t.ref),
    );
    const data: Prisma.TxnCreateManyInput[] = [];
    for (const r of money) {
      const playerId = r.user && players.ids.get(String(r.user.id));
      if (have.has(r.id) || !playerId) continue;
      const d = json<Record<string, unknown>>(r.details) ?? {};
      const src = sourceOf(r, d);
      data.push({
        brandId,
        playerId,
        type: r.type as "DEPOSIT" | "WITHDRAW",
        amount: Math.abs(Math.round(Number(r.cash) * 100) / 100),
        txnAt: new Date(r.endDateTime || r.processedDateTime || r.createdDateTime),
        channelId: src ? await channelFor(link, map, src.key, src.label) : null,
        ref: r.id,
        source: src?.key ?? null,
        payBank: r.type === "WITHDRAW" ? String(d.bank ?? "").slice(0, 80) || null : null,
        payAccount: r.type === "WITHDRAW" ? String(d.payID || d.bankAccountNumber || "").slice(0, 60) || null : null,
      });
    }
    if (data.length) {
      txns = (await prisma.txn.createMany({ data, skipDuplicates: true })).count;
      const ids = [...new Set(data.map((d) => d.playerId))];
      await refreshPlayerStats(ids);
      await safely("platform sync", () => trackPlayers(ids, data.map((d) => d.txnAt as Date)));
    }
  }

  if (bonus.length) {
    const promos = new Map((await prisma.promotion.findMany({ where: { brandId }, select: { id: true, name: true } })).map((p) => [p.name.toLowerCase(), p.id]));
    const data: Prisma.PromoClaimCreateManyInput[] = [];
    for (const r of bonus) {
      const playerId = r.user && players.ids.get(String(r.user.id));
      if (!playerId) continue;
      const d = json<Record<string, unknown>>(r.details) ?? {};
      const name = (plainText(r.promotion?.name || String(d.angpao ?? "")) || "Bonus").slice(0, 120);
      let promotionId = promos.get(name.toLowerCase());
      if (!promotionId) {
        promotionId = (await prisma.promotion.upsert({ where: { brandId_name: { brandId, name } }, create: { brandId, name }, update: {} })).id;
        promos.set(name.toLowerCase(), promotionId);
      }
      data.push({ promotionId, playerId, amount: Math.abs(Math.round(Number(r.cash) * 100) / 100), claimedAt: new Date(r.createdDateTime), ref: r.id });
    }
    if (data.length) {
      claims = (await prisma.promoClaim.createMany({ data, skipDuplicates: true })).count;
      if (claims) await safely("platform claims", () => linkClaims({ ref: { in: data.map((d) => d.ref!) }, promotion: { brandId } }));
    }
  }
  return { txns, claims, players: players.created };
}

/** Deposits, withdrawals and bonus claims, read a day at a time from where the last run stopped. */
async function syncTxns(link: PlatformLink & { brand: { name: string; currency: string } }, c: Creds, out: SyncResult, map: ChannelMap) {
  const now = new Date();
  const deep = !link.deepAt || now.getTime() - link.deepAt.getTime() > HOUR;
  let from = link.txnCursor ? new Date(link.txnCursor.getTime() - (deep ? DEEP_LOOKBACK : LOOKBACK)) : link.startAt;
  if (from < link.startAt) from = link.startAt;
  let cursor = link.txnCursor;
  while (from < now) {
    const to = new Date(Math.min(from.getTime() + 24 * HOUR, now.getTime()));
    const rows: PlatformTxn[] = [];
    let pages = 1;
    for (let p = 0; p < pages; p++) {
      if (out.pages >= PAGE_BUDGET) {
        out.more = true;
        break;
      }
      const page = await getTransactions(c, { sDate: platformTime(from, link.timeZone), eDate: platformTime(to, link.timeZone), pageIndex: p });
      out.pages++;
      pages = page.totalPage || 0;
      rows.push(...(page.transactions ?? []));
    }
    const r = await saveTxns(link, map, rows.filter((x) => new Date(x.createdDateTime) >= link.startAt));
    out.txns += r.txns;
    out.claims += r.claims;
    out.players += r.players;
    if (out.more) break;
    cursor = to;
    from = to;
  }
  // The cursor moves past each fully read day, so a long catch-up continues where it stopped.
  const data: Prisma.PlatformLinkUpdateInput = { channelMap: map };
  if (cursor && (!link.txnCursor || cursor > link.txnCursor)) data.txnCursor = cursor;
  if (deep && !out.more) data.deepAt = now;
  await prisma.platformLink.update({ where: { id: link.id }, data });
}

/** New registrations since the last run (newest first, until one we already have). */
async function syncPlayers(link: PlatformLink, c: Creds, out: SyncResult) {
  const floor = link.playerCursor ?? link.startAt;
  let newest = link.playerCursor;
  const fresh: PlatformUser[] = [];
  let done = false;
  for (let p = 0; p < 10 && !done && out.pages < PAGE_BUDGET; p++) {
    const page = await getUsers(c, { sortBy: "register", sortType: "DESC", pageIndex: p });
    out.pages++;
    const users = page.users ?? [];
    for (const u of users) {
      const at = when(u.createdDateTime);
      if (!at || at <= floor) {
        done = true;
        break;
      }
      fresh.push(u);
      if (!newest || at > newest) newest = at;
    }
    if (!users.length || (page.totalPage != null && p + 1 >= page.totalPage)) done = true;
  }
  if (fresh.length) out.players += (await resolvePlayers(link.brandId, fresh)).created;
  // Fill in registration details for players first seen through a transaction.
  const bare = await prisma.player.findMany({ where: { brandId: link.brandId, extId: { not: null }, registeredAt: null, id: { notIn: [...triedEnrich] } }, select: { id: true, extId: true }, take: 10 });
  for (const b of bare) {
    if (out.pages >= PAGE_BUDGET) break;
    triedEnrich.add(b.id);
    const u = (await getUsers(c, { id: b.extId! })).users?.[0];
    out.pages++;
    if (u?.createdDateTime) await prisma.player.update({ where: { id: b.id }, data: { registeredAt: new Date(u.createdDateTime), referrer: referrerOf(u) } });
  }
  if (done && newest && (!link.playerCursor || newest > link.playerCursor)) await prisma.platformLink.update({ where: { id: link.id }, data: { playerCursor: newest } });
}
const triedEnrich = new Set<number>();

/**
 * Daily bets and game win/loss per player. The platform only has a day's report once that day is over,
 * so each finished day is read until it comes back with data (or is 3 days old and really was empty). Checked every 15 minutes.
 */
async function syncBets(link: PlatformLink, c: Creds, out: SyncResult, force: boolean) {
  const now = new Date();
  if (!force && link.betAt && now.getTime() - link.betAt.getTime() < 15 * 60_000) return;
  const tz = link.timeZone;
  const today = platformDay(now, tz);
  const first = link.betDay ? addDays(link.betDay, 1) : platformDay(link.startAt, tz);
  let betDay = link.betDay;
  let lookups = 0;
  for (let d = first, n = 0; d < today && n < 4; d = addDays(d, 1), n++) {
    const raw = await getDailyBets(c, d);
    out.pages++;
    const data = Array.isArray(raw) ? {} : raw;
    const ids = Object.keys(data);
    const known = (await resolveKnown(link.brandId, ids)) ?? new Map<string, number>();
    const unknown = ids.filter((id) => !known.has(id));
    let complete = true;
    const users: PlatformUser[] = [];
    for (const id of unknown) {
      if (lookups >= 40 || out.pages >= PAGE_BUDGET) {
        complete = false;
        break;
      }
      lookups++;
      out.pages++;
      // getAllUsers by id: it also gives the registration time, and getDetail isn't enabled for every key.
      const u = (await getUsers(c, { id })).users?.[0];
      users.push({ ...u, id });
    }
    if (users.length) {
      const r = await resolvePlayers(link.brandId, users);
      out.players += r.created;
      for (const [k, v] of r.ids) known.set(k, v);
    }
    const day = new Date(`${d}T00:00:00Z`);
    const rows = ids
      .filter((id) => known.has(id))
      .map((id) => {
        const { total, ...sites } = data[id];
        return { brandId: link.brandId, playerId: known.get(id)!, day, bet: Number(total?.bet ?? 0), winlose: Number(total?.winlose ?? 0), sites };
      });
    await prisma.$transaction([prisma.playerDay.deleteMany({ where: { brandId: link.brandId, day } }), prisma.playerDay.createMany({ data: rows, skipDuplicates: true })]);
    out.betDays++;
    if (!complete) {
      out.more = true;
      break;
    }
    if (!ids.length && d > addDays(today, -3)) break;
    if (!betDay || d > betDay) betDay = d;
  }
  await prisma.platformLink.update({ where: { id: link.id }, data: { betDay, betAt: out.more ? null : now } });
}

async function resolveKnown(brandId: number, extIds: string[]) {
  if (!extIds.length) return new Map<string, number>();
  const ps = await prisma.player.findMany({ where: { brandId, extId: { in: extIds } }, select: { id: true, extId: true } });
  return new Map(ps.map((p) => [p.extId!, p.id]));
}

const running = new Set<number>();

/** One brand's sync. Saves when it ran, what it added and what went wrong. */
export async function syncLink(linkId: number, force = false): Promise<SyncResult & { error?: string }> {
  const out: SyncResult = { txns: 0, claims: 0, players: 0, betDays: 0, pages: 0, more: false };
  if (running.has(linkId)) return { ...out, error: "A sync for this brand is already running." };
  running.add(linkId);
  try {
    const link = await prisma.platformLink.findUniqueOrThrow({ where: { id: linkId }, include: { brand: { select: { name: true, currency: true } } } });
    await prisma.platformLink.update({ where: { id: linkId }, data: { lastRunAt: new Date() } });
    const c = credsOf(link);
    const map = { ...((link.channelMap as ChannelMap | null) ?? {}) };
    try {
      if (link.syncTxns || link.syncClaims) await syncTxns(link, c, out, map);
      if (link.syncPlayers) await syncPlayers(link, c, out);
      if (link.syncBets) await syncBets(link, c, out, force);
      await prisma.platformLink.update({ where: { id: linkId }, data: { lastOkAt: new Date(), lastError: null, lastResult: { ...out, at: new Date().toISOString() } } });
      return out;
    } catch (e) {
      const error = (e as Error).message.slice(0, 500);
      await prisma.platformLink.update({ where: { id: linkId }, data: { lastError: error, lastResult: { ...out, at: new Date().toISOString() }, channelMap: map } });
      return { ...out, error };
    }
  } finally {
    running.delete(linkId);
  }
}

/** Every enabled brand, one after another. Called by the timer every 2 minutes. */
export async function syncAll() {
  const links = await prisma.platformLink.findMany({ where: { enabled: true, brand: { active: true } }, select: { id: true, brandId: true } });
  const result: Record<number, SyncResult & { error?: string }> = {};
  for (const l of links) result[l.brandId] = await syncLink(l.id);
  return result;
}
