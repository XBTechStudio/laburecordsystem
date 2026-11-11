import "server-only";

import type { PlatformLink, Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { groupFor } from "@/lib/bank-groups";
import { getSettings } from "@/lib/settings";
import { addDays } from "@/lib/dates";
import { phoneKey } from "@/lib/format";
import {
  call,
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
import { voidReissued } from "@/lib/promo-voids";
import { open } from "@/lib/secret-box";

// Reads each connected brand's platform on a timer: completed deposits and withdrawals, bonus claims,
// new registrations and daily bets. Everything is matched by the platform's own ids, so reading the
// same stretch twice never adds anything twice.

const HOUR = 3600_000;
/** Most result pages one run may read, so a long catch-up is spread over several runs. Pages hold 10 rows; at 10 calls a second
 *  shared by all brands (lib/platform-api.ts), five brands' runs still fit in the 2-minute timer. */
const PAGE_BUDGET = 300;
/** Transactions are read this much at a time, so a run that runs out of pages still keeps what it finished. */
const WINDOW = 6 * HOUR;
/** Transactions are re-read this far back on every run (pending ones complete late)… */
const LOOKBACK = 2 * HOUR;
/** …and once an hour this far back. */
const DEEP_LOOKBACK = 48 * HOUR;
/** Credits paid outside the platform's promotions; each ends the promotion the player was under (see PlayerCredit). */
export const CREDITS = ["REBATE", "COMMISSION"];
/** Kept in PlayerCredit as well: cleared balances, to find bonuses cleared by mistake and given again (lib/promo-voids.ts). */
const KEPT = [...CREDITS, "FORFEITED"];
const DAY = 24 * HOUR;

export type ChannelMap = Record<string, { id: number; label: string }>;
export type SyncResult = { txns: number; claims: number; players: number; betDays: number; pages: number; more: boolean; /** Synced transactions removed because the platform rejected them afterwards. */ undone: number };

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

/** The platform id of the member who referred this one (their upline), if any. */
const uplineOf = (u: PlatformUser) => (u.referrerId ? String(u.referrerId).slice(0, 40) : null);
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
        ...(uplineOf(i.u) ? { uplineExtId: uplineOf(i.u) } : {}),
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
        uplineExtId: uplineOf(i.u),
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
  // An offline bank of an agent (X Group, Mimi Pay…) goes into the agent's one account for all brands.
  const group = key.startsWith("bank:") ? groupFor(label, await bankGroups()) : null;
  const hit = map[key];
  // A remark added or changed on the platform later (label differs) moves the bank into its agent from then on.
  const moved = group && hit && hit.label !== label;
  if (hit && !moved && (checked.has(hit.id) || (await prisma.payChannel.count({ where: { id: hit.id } })))) return checked.add(hit.id), hit.id;
  const name = (group ?? `${link.brand.name} · ${label}`).slice(0, 80);
  const c = await prisma.payChannel.upsert({
    where: { name },
    create: { name, type: group ? "PG_OFFLINE" : key.startsWith("bank:") ? "BANK" : "PG", currency: link.brand.currency },
    update: {},
  });
  map[key] = { id: c.id, label };
  return c.id;
}

const checked = new Set<number>();

let groupsCache: { at: number; groups: Awaited<ReturnType<typeof getSettings>>["bankGroups"] } | null = null;
/** The agent list, read at most once a minute (this runs for every synced transaction). */
async function bankGroups() {
  if (!groupsCache || Date.now() - groupsCache.at > 60_000) groupsCache = { at: Date.now(), groups: (await getSettings()).bankGroups };
  return groupsCache.groups;
}

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
  const credits = rows.filter((r) => KEPT.includes(r.type) && link.syncClaims);
  if (!money.length && !bonus.length && !credits.length) return { txns: 0, claims: 0, players: 0 };
  const players = await resolvePlayers(
    brandId,
    [...money, ...bonus, ...credits].map((r) => r.user!).filter(Boolean),
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
    // Like deposits, a platform transaction counts once per brand, whichever promotion it is under.
    const have = new Map(
      (await prisma.promoClaim.findMany({ where: { ref: { in: bonus.map((r) => r.id) }, promotion: { brandId } }, select: { ref: true, promotionId: true } })).map((c) => [c.ref!, c.promotionId]),
    );
    // Promotions are found by the platform's promotion id, which stays the same when either side renames one;
    // by name only until a promotion has been seen with its id, and for bonuses without one (e.g. a hand-given angpao).
    const list = await prisma.promotion.findMany({ where: { brandId }, select: { id: true, name: true, platformId: true, platformName: true } });
    const byPid = new Map(list.filter((p) => p.platformId).map((p) => [p.platformId!, p.id]));
    const hasPid = new Set(byPid.values());
    const byName = new Map([
      ...list.filter((p) => !p.platformName).map((p) => [p.name.toLowerCase(), p.id] as const),
      ...list.filter((p) => p.platformName).map((p) => [p.platformName!.toLowerCase(), p.id] as const),
    ]);
    /** Remembers that a promotion is the platform's `pid`, unless it already has an id or another promotion has this one. */
    const learn = async (promotionId: number, pid: string) => {
      if (hasPid.has(promotionId) || byPid.has(pid)) return;
      await prisma.promotion.update({ where: { id: promotionId }, data: { platformId: pid } });
      hasPid.add(promotionId);
      byPid.set(pid, promotionId);
    };
    const data: Prisma.PromoClaimCreateManyInput[] = [];
    for (const r of bonus) {
      const pid = r.promotion?.id ? String(r.promotion.id).slice(0, 40) : null;
      const filed = have.get(r.id);
      if (filed !== undefined) {
        // Already saved, so its promotion is the platform's pid: fills in the ids of promotions saved before they were kept.
        if (pid) await learn(filed, pid);
        continue;
      }
      const playerId = r.user && players.ids.get(String(r.user.id));
      if (!playerId) continue;
      const d = json<Record<string, unknown>>(r.details) ?? {};
      const name = (plainText(r.promotion?.name || String(d.angpao ?? "")) || "Bonus").slice(0, 120);
      let promotionId = (pid && byPid.get(pid)) || byName.get(name.toLowerCase());
      if (!promotionId) {
        promotionId = (await prisma.promotion.upsert({ where: { brandId_name: { brandId, name } }, create: { brandId, name, platformName: name }, update: {} })).id;
        byName.set(name.toLowerCase(), promotionId);
      }
      if (pid) await learn(promotionId, pid);
      // The same row can come twice in one read (pages shifting while new bonuses arrive).
      have.set(r.id, promotionId);
      data.push({ promotionId, playerId, amount: Math.abs(Math.round(Number(r.cash) * 100) / 100), claimedAt: new Date(r.createdDateTime), ref: r.id });
    }
    if (data.length) {
      claims = (await prisma.promoClaim.createMany({ data, skipDuplicates: true })).count;
      if (claims) await safely("platform claims", () => linkClaims({ ref: { in: data.map((d) => d.ref!) }, promotion: { brandId } }));
    }
  }
  if (credits.length) {
    const data: Prisma.PlayerCreditCreateManyInput[] = [];
    for (const r of credits) {
      const playerId = r.user && players.ids.get(String(r.user.id));
      if (playerId) data.push({ brandId, playerId, kind: r.type, amount: Math.abs(Math.round(Number(r.cash) * 100) / 100), at: new Date(r.createdDateTime), ref: r.id });
    }
    if (data.length) await prisma.playerCredit.createMany({ data, skipDuplicates: true });
  }
  // A bonus or a cleared balance just read may complete a "cleared by mistake, given again" pair.
  const touched = [...bonus, ...credits.filter((r) => r.type === "FORFEITED")];
  const ids = [...new Set(touched.map((r) => r.user && players.ids.get(String(r.user.id))).filter((x): x is number => !!x))];
  if (ids.length) {
    const since = new Date(Math.min(...touched.map((r) => new Date(r.createdDateTime).getTime())) - DAY);
    await safely("reissued bonuses", () => voidReissued(brandId, since, ids));
  }
  return { txns, claims, players: players.created };
}

/** Brands whose undone transactions have been looked for since the server started (the first look reaches further back). */
const swept = new Set<number>();
/** Brands checked for bonuses cleared by mistake since the server started. */
const voidSwept = new Set<number>();
/** How far back undone transactions are looked for every hour. Staff undo within minutes to an hour (they reject, then re-enter
 *  the split amounts), so six hours is plenty; the first run after a start (at least weekly) reaches back further. */
const UNDONE_LOOKBACK = 6 * HOUR;
/** On the first run after a start (the server restarts weekly), to catch anything the hourly look missed. */
const UNDONE_FIRST_LOOKBACK = 7 * 24 * HOUR;

/**
 * Staff sometimes reject a deposit or withdrawal after it completed, e.g. to split a manual top-up of 100 into
 * 30 + 30 + 40. We saved it while it was completed, so it is removed here once the platform lists it as rejected. Cancelled ones are not looked for: none of them had been saved.
 * Only rows the sync saved itself are removed, never ones staff entered or imported.
 */
async function dropUndone(link: PlatformLink, c: Creds, out: SyncResult, now: Date) {
  const from = new Date(Math.max(now.getTime() - (swept.has(link.id) ? UNDONE_LOOKBACK : UNDONE_FIRST_LOOKBACK), link.startAt.getTime()));
  const undone = new Map<string, { type: "DEPOSIT" | "WITHDRAW"; status: string }>();
  for (const status of ["REJECTED"])
    for (const type of ["DEPOSIT", "WITHDRAW"] as const)
      for (let p = 0; ; p++) {
        out.pages++;
        const page = await call<{ transactions: PlatformTxn[]; totalPage: number }>(c, "/transactions/getAllTransactions", {
          sDate: platformTime(from, link.timeZone),
          eDate: platformTime(now, link.timeZone),
          pageIndex: p,
          type,
          status,
        });
        for (const t of page.transactions ?? []) undone.set(t.id, { type, status });
        if (p + 1 >= (page.totalPage || 0)) break;
      }
  swept.add(link.id);
  if (!undone.size) return;
  const gone = await prisma.txn.findMany({
    where: { brandId: link.brandId, ref: { in: [...undone.keys()] }, createdById: null, importId: null },
    include: { player: { select: { username: true } } },
  });
  const rows = gone.filter((t) => undone.get(t.ref!)?.type === t.type);
  if (!rows.length) return;
  await prisma.txn.deleteMany({ where: { id: { in: rows.map((t) => t.id) } } });
  const ids = [...new Set(rows.map((t) => t.playerId))];
  await refreshPlayerStats(ids);
  await safely("platform undone", () => trackPlayers(ids, rows.map((t) => t.txnAt)));
  out.undone += rows.length;
  for (const t of rows)
    await audit(null, "DELETE", "Txn", t.id, link.brandId, `Platform ${undone.get(t.ref!)!.status.toLowerCase()} ${t.type.toLowerCase()} ${t.ref} of ${t.amount} for ${t.player.username} after it completed`, t);
}

/** Where each brand's hourly 48-hour re-read has got to, when it needs more than one run. */
const deepFrom = new Map<number, Date>();

/**
 * Deposits, withdrawals and bonus claims, read up to six hours at a time from where the last run stopped. New ones are read
 * first; the hourly re-read of the last 48 hours uses what is left of the run's pages and carries on in the next runs, so
 * however busy a brand is, it never holds up new transactions.
 */
async function syncTxns(link: PlatformLink & { brand: { name: string; currency: string } }, c: Creds, out: SyncResult, map: ChannelMap) {
  const now = new Date();
  // While catching up on old history nothing is still pending, so there is nothing to read again.
  const catchingUp = link.txnCursor && now.getTime() - link.txnCursor.getTime() > DEEP_LOOKBACK;
  let from = link.txnCursor ? new Date(link.txnCursor.getTime() - (catchingUp ? 0 : LOOKBACK)) : link.startAt;
  if (from < link.startAt) from = link.startAt;
  const recentFrom = from;
  let cursor = link.txnCursor;
  // Only the types we keep. Forfeits (cleared balances) are many, but needed to find bonuses cleared by mistake.
  const types = [...(link.syncTxns ? ["DEPOSIT", "WITHDRAW"] : []), ...(link.syncClaims ? ["BONUS", ...KEPT] : [])];
  const read = (from: Date, to: Date, type: string, pageIndex: number) => {
    out.pages++;
    return getTransactions(c, { sDate: platformTime(from, link.timeZone), eDate: platformTime(to, link.timeZone), pageIndex, type });
  };
  /** Reads from..until window by window, calling done(to) after each; false when the run's pages ran out first. */
  const span = async (from: Date, until: Date, done: (to: Date) => unknown) => {
    while (from < until) {
      let to = new Date(Math.min(from.getTime() + WINDOW, until.getTime()));
      // Each type's first page says how many pages the window has. A window too big for a whole run is halved
      // (busy stretches can be thousands of rows an hour); one that only doesn't fit what this run has left waits for the next run.
      let firsts: { type: string; page: Awaited<ReturnType<typeof getTransactions>> }[] = [];
      for (;;) {
        if (out.pages + types.length > PAGE_BUDGET) return false;
        firsts = [];
        for (const type of types) firsts.push({ type, page: await read(from, to, type, 0) });
        const rest = firsts.reduce((n, f) => n + Math.max((f.page.totalPage || 0) - 1, 0), 0);
        if (out.pages + rest <= PAGE_BUDGET) break;
        if (rest > PAGE_BUDGET - 4 * types.length && to.getTime() - from.getTime() > 15 * 60_000) {
          to = new Date(from.getTime() + (to.getTime() - from.getTime()) / 2);
          continue;
        }
        return false;
      }
      const rows: PlatformTxn[] = [];
      for (const { type, page } of firsts) {
        rows.push(...(page.transactions ?? []));
        for (let p = 1; p < (page.totalPage || 0); p++) rows.push(...((await read(from, to, type, p)).transactions ?? []));
      }
      const r = await saveTxns(link, map, rows.filter((x) => new Date(x.createdDateTime) >= link.startAt));
      out.txns += r.txns;
      out.claims += r.claims;
      out.players += r.players;
      await done(to);
      from = to;
    }
    return true;
  };

  // The cursor is saved after each window, so a run cut short (a platform timeout) keeps what it finished.
  out.more = !(await span(from, now, async (to) => {
    if (cursor && to <= cursor) return;
    cursor = to;
    await prisma.platformLink.update({ where: { id: link.id }, data: { txnCursor: to } });
  }));
  // Once an hour (after new ones are in), the last 48 hours are read again for transactions that completed late.
  let deepDone = false;
  if (!out.more && !catchingUp && link.txnCursor && (!link.deepAt || now.getTime() - link.deepAt.getTime() > HOUR)) {
    const start = deepFrom.get(link.id) ?? new Date(Math.max(link.txnCursor.getTime() - DEEP_LOOKBACK, link.startAt.getTime()));
    deepDone = await span(start, recentFrom, (to) => deepFrom.set(link.id, to));
    if (deepDone) deepFrom.delete(link.id);
    else out.more = true;
  }
  const deep = deepDone;
  // Once after each start, the whole recent history is checked for bonuses cleared by mistake and given again.
  if (!out.more && link.syncClaims && !voidSwept.has(link.id)) {
    voidSwept.add(link.id);
    await safely("reissued bonuses", () => voidReissued(link.brandId, new Date(now.getTime() - 120 * DAY)));
  }
  // A failure here must not stop the sync: the rest of the run (and the cursor) is unaffected.
  if (deep && !out.more && link.syncTxns) await dropUndone(link, c, out, now).catch((e) => console.error(`platform sync: undone check for brand ${link.brandId} failed`, e));
  // The cursor moves past each fully read window, so a long catch-up continues where it stopped.
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
    if (u?.createdDateTime) await prisma.player.update({ where: { id: b.id }, data: { registeredAt: new Date(u.createdDateTime), referrer: referrerOf(u), uplineExtId: uplineOf(u) } });
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
  const out: SyncResult = { txns: 0, claims: 0, players: 0, betDays: 0, pages: 0, more: false, undone: 0 };
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

/** Every enabled brand at the same time (each is its own platform). Called by the timer every 2 minutes. */
export async function syncAll() {
  const links = await prisma.platformLink.findMany({ where: { enabled: true, brand: { active: true } }, select: { id: true, brandId: true } });
  const runs = await Promise.all(links.map(async (l) => [l.brandId, await syncLink(l.id)] as const));
  return Object.fromEntries(runs) as Record<number, SyncResult & { error?: string }>;
}
