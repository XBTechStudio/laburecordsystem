"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, str, UserError, type Result } from "@/lib/action";
import { fromLocalInput } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { getT } from "@/lib/i18n-server";
import { call, getBanks, platformTime, type Creds } from "@/lib/platform-api";
import { credsOf, syncLink, type ChannelMap } from "@/lib/platform-sync";
import { seal } from "@/lib/secret-box";

const path = (brandId: number) => `/admin/brands/${brandId}/platform`;

/** Tries every call the sync uses, so a key missing one permission shows up straight away. */
async function probe(c: Creds, tz: string) {
  const t = await getT();
  const banks = await getBanks(c);
  const now = new Date();
  const checks: [string, () => Promise<unknown>][] = [
    [t("Transactions"), () => call(c, "/transactions/getAllTransactions", { status: "COMPLETED", sDate: platformTime(new Date(now.getTime() - 3600_000), tz), eDate: platformTime(now, tz) })],
    [t("Players"), () => call(c, "/users/getAllUsers", { pageIndex: 0 })],
    [t("Daily bets"), () => call(c, "/reports/dailyBetTotal", { date: platformTime(now, tz).slice(0, 10) })],
  ];
  const failed: string[] = [];
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message}`);
    }
  }
  const head = t("Connected. The platform shows {n} bank accounts.", { n: banks.length });
  return failed.length ? { message: `${head} ${t("Not allowed for this key:")} ${failed.join(" · ")}`, warn: true } : { message: `${head} ${t("Transactions, players and daily bets all answer.")}` };
}

export async function savePlatform(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("brands", 3);
    const brandId = int(fd, "brandId");
    const brand = await prisma.brand.findUniqueOrThrow({ where: { id: brandId } });
    const old = await prisma.platformLink.findUnique({ where: { brandId } });
    const apiUrl = str(fd, "apiUrl");
    const merchantId = str(fd, "merchantId");
    const accessId = str(fd, "accessId");
    const token = str(fd, "token");
    const timeZone = str(fd, "timeZone") || "Australia/Sydney";
    const start = str(fd, "startAt");
    need(/^https:\/\/[^\s]+$/i.test(apiUrl), "The API address must start with https://");
    need(merchantId && accessId, "Fill in the merchant ID and the Access ID.");
    need(token || old, "Fill in the token.");
    need(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start), "Choose from when to read.");
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format();
    } catch {
      throw new UserError("Time zone not recognised. Use a name like Australia/Sydney or Asia/Singapore.");
    }
    const startAt = fromLocalInput(start);
    const flags = {
      syncTxns: fd.get("syncTxns") === "on",
      syncClaims: fd.get("syncClaims") === "on",
      syncPlayers: fd.get("syncPlayers") === "on",
      syncBets: fd.get("syncBets") === "on",
    };
    const tokenEnc = token ? seal(token) : old!.tokenEnc;
    const creds = credsOf({ apiUrl, merchantId, accessId, tokenEnc });
    // A different start, platform or key: read everything again from the start (nothing is added twice).
    const restart = !old || old.startAt.getTime() !== startAt.getTime() || old.merchantId !== merchantId || old.apiUrl !== apiUrl || old.timeZone !== timeZone;
    const data = {
      apiUrl,
      merchantId,
      accessId,
      tokenEnc,
      timeZone,
      startAt,
      ...flags,
      ...(restart ? { txnCursor: null, deepAt: null, playerCursor: null, betDay: null, betAt: null } : {}),
    };
    await prisma.platformLink.upsert({ where: { brandId }, create: { brandId, ...data }, update: data });
    await audit(user, old ? "UPDATE" : "CREATE", "PlatformLink", brandId, brandId, `${old ? "Changed" : "Connected"} platform API for ${brand.name}`, {
      apiUrl,
      merchantId,
      accessId,
      timeZone,
      startAt,
      ...flags,
      tokenChanged: !!token,
    });
    revalidatePath(path(brandId));
    try {
      return await probe(creds, timeZone);
    } catch (e) {
      return { message: `${(await getT())("Saved, but the connection test failed:")} ${(e as Error).message}`, warn: true };
    }
  });
}

export async function setPlatformEnabled(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("brands", 3);
    const brandId = int(fd, "brandId");
    const on = str(fd, "on") === "1";
    const link = await prisma.platformLink.update({ where: { brandId }, data: { enabled: on }, include: { brand: true } });
    await audit(user, "UPDATE", "PlatformLink", brandId, brandId, `${on ? "Started" : "Paused"} platform sync for ${link.brand.name}`);
    revalidatePath(path(brandId));
    return on ? "Sync started. It runs every 2 minutes." : "Sync paused. Nothing is read until you start it again.";
  });
}

export async function syncPlatformNow(_p: Result, fd: FormData) {
  return run(async () => {
    await guard("brands", 3);
    const brandId = int(fd, "brandId");
    const link = await prisma.platformLink.findUniqueOrThrow({ where: { brandId } });
    const r = await syncLink(link.id, true);
    revalidatePath(path(brandId));
    if (r.error) throw new UserError(r.error);
    const t = await getT();
    return {
      message: `${t("Added {txns} transactions, {claims} bonus claims, {players} new players; read {days} days of bets.", { txns: r.txns, claims: r.claims, players: r.players, days: r.betDays })}${r.more ? " " + t("There is more to read; it continues on the next run.") : ""}`,
    };
  });
}

export async function deletePlatform(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("brands", 3);
    const brandId = int(fd, "brandId");
    const link = await prisma.platformLink.delete({ where: { brandId }, include: { brand: true } });
    await audit(user, "DELETE", "PlatformLink", brandId, brandId, `Removed platform API for ${link.brand.name}`);
    revalidatePath(path(brandId));
    return "Connection removed. Data already read stays.";
  });
}

/** Points platform banks / payment methods at our PG / bank accounts; transactions already read move with them. */
export async function saveChannelMap(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("brands", 3);
    const brandId = int(fd, "brandId");
    const link = await prisma.platformLink.findUniqueOrThrow({ where: { brandId } });
    const map = { ...((link.channelMap as ChannelMap | null) ?? {}) };
    let moved = 0;
    for (const [key, v] of Object.entries(map)) {
      const id = int(fd, `ch:${key}`);
      if (!Number.isInteger(id) || id === v.id) continue;
      need(await prisma.payChannel.count({ where: { id } }), "That PG / bank no longer exists. Refresh the page.");
      map[key] = { ...v, id };
      moved += (await prisma.txn.updateMany({ where: { brandId, source: key }, data: { channelId: id } })).count;
    }
    await prisma.platformLink.update({ where: { brandId }, data: { channelMap: map } });
    await audit(user, "UPDATE", "PlatformLink", brandId, brandId, `Changed platform account mapping (${moved} transactions moved)`, map);
    revalidatePath(path(brandId));
    return (await getT())("Saved. {n} transactions moved to the chosen accounts.", { n: moved });
  });
}
