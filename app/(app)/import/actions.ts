"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type TxnType } from "@prisma/client";
import { assertBrand, can, Denied, guard } from "@/lib/auth";
import { txnModule } from "@/lib/perms";
import { audit } from "@/lib/audit";
import { int, need, run, str, UserError, type Result } from "@/lib/action";
import { fromLocalInput } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { getT } from "@/lib/i18n-server";
import { ensurePlayers, refreshPlayerStats } from "@/lib/players";
import { linkClaims, safely, trackPlayers, unlinkClaims } from "@/lib/promo-engine";
import { DEFAULT_BOX } from "@/lib/box-rule";
import { trackBoxes } from "@/lib/lucky-box";

/** Rows arrive already normalised by the browser: times as "YYYY-MM-DDTHH:mm" (Malaysia), dates as "YYYY-MM-DD", amounts as numbers. */
export type ImportRow = {
  username?: string;
  type?: TxnType;
  amount?: number;
  time?: string;
  ref?: string;
  channel?: string;
  payBank?: string;
  payAccount?: string;
  note?: string;
  phone?: string;
  name?: string;
  promo?: string;
};

export type ImportKind = "txn" | "player" | "claim" | "box";

const KIND_LABEL: Record<ImportKind, string> = { txn: "transactions", player: "players", claim: "promotion claims", box: "Lucky Box entries" };
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

async function access(brandId: number) {
  const user = await guard("import", 2);
  assertBrand(user, brandId);
  const b = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!b?.active) throw new Denied("This brand is not active.");
  return { user, brand: b };
}

export async function listTemplates(kind: string) {
  await guard("import", 2);
  const t = await prisma.importTemplate.findMany({ where: { kind }, orderBy: { name: "asc" } });
  return t.map((x) => ({ id: x.id, name: x.name, mapping: x.mapping as Record<string, unknown>, headerSig: x.headerSig }));
}

export async function saveTemplate(kind: string, name: string, mapping: Record<string, unknown>, headerSig: string) {
  await guard("import", 2);
  const t = await getT();
  const clean = name.trim().slice(0, 120);
  if (!clean) return { ok: false, message: t("Give the template a name.") };
  await prisma.importTemplate.upsert({
    where: { name_kind: { name: clean, kind } },
    create: { name: clean, kind, mapping: mapping as object, headerSig: headerSig.slice(0, 500) },
    update: { mapping: mapping as object, headerSig: headerSig.slice(0, 500) },
  });
  return { ok: true, message: t("Template “{name}” saved.", { name: clean }) };
}

export async function startImport(brandId: number, kind: ImportKind, filename: string, total: number) {
  const { user } = await access(brandId);
  const b = await prisma.importBatch.create({ data: { brandId, kind, filename: filename.slice(0, 200), total, userName: user.name } });
  return b.id;
}

type ChunkResult = { inserted: number; skipped: number; created: number; problems: string[]; newChannels: string[] };

/** Imports one chunk. Rows already in the system (same reference, or same player/type/amount/time) are skipped, so re-importing a file is safe. */
export async function importChunk(batchId: number, rows: ImportRow[], offset: number): Promise<ChunkResult & { error?: string }> {
  const t = await getT();
  try {
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    const { user } = await access(batch.brandId);
    need(!batch.undoneAt, "This import was undone.");
    need(rows.length <= 1000, "Chunk too large.");
    const brandId = batch.brandId;
    const kind = batch.kind as ImportKind;
    const problems: string[] = [];
    const bad = (i: number, msg: string, vars?: Record<string, string | number>) => problems.push(`${t("Row {n}", { n: offset + i + 1 })}: ${t(msg, vars)}`);
    let inserted = 0;
    let skipped = 0;
    let created = 0;
    const newChannels: string[] = [];

    if (kind === "player") {
      const ok = rows.filter((r, i) => (r.username?.trim() ? true : (bad(i, "no username"), false)));
      const before = await prisma.player.count({ where: { brandId } });
      const res = await ensurePlayers(brandId, ok.map((r) => ({ username: r.username!, phone: r.phone, name: r.name })), batchId);
      created = res.created;
      inserted = (await prisma.player.count({ where: { brandId } })) - before;
      skipped = ok.length - inserted;
    }

    if (kind === "txn") {
      // PG/bank names not seen before become new accounts, so every transaction counts towards a balance.
      const channels = await prisma.payChannel.findMany();
      // A PG/bank can be named in the file by its name or its short code.
      const chByName = new Map([...channels.flatMap((c) => (c.code ? [[c.code.toLowerCase(), c.id] as const] : [])), ...channels.map((c) => [c.name.toLowerCase(), c.id] as const)]);
      const brand = await prisma.brand.findUniqueOrThrow({ where: { id: brandId } });
      for (const name of new Set(rows.map((r) => r.channel?.trim()).filter((x): x is string => !!x))) {
        if (chByName.has(name.toLowerCase())) continue;
        const type = /pay|pg|gateway|flash|power/i.test(name) && !/bank|posb|dbs|ocbc|uob|maybank|cimb/i.test(name) ? "PG" : "BANK";
        const c = await prisma.payChannel.upsert({ where: { name: name.slice(0, 80) }, create: { name: name.slice(0, 80), type, currency: brand.currency }, update: {} });
        chByName.set(name.toLowerCase(), c.id);
        newChannels.push(c.name);
      }
      const ok = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r, i }) => {
          if (!r.username?.trim()) return bad(i, "no username"), false;
          if (r.type !== "DEPOSIT" && r.type !== "WITHDRAW") return bad(i, "type is not deposit or withdrawal"), false;
          if (!can(user, txnModule(r.type), 2)) return bad(i, r.type === "DEPOSIT" ? "your role may not enter deposits" : "your role may not enter withdrawals"), false;
          if (!(Number(r.amount) > 0)) return bad(i, "amount missing or 0"), false;
          if (!r.time || !TIME.test(r.time)) return bad(i, "date/time not recognised"), false;
          return true;
        });
      const res = await ensurePlayers(brandId, ok.map(({ r }) => ({ username: r.username!, phone: r.phone, name: r.name })), batchId);
      created = res.created;
      const data = ok.map(({ r }) => ({
        brandId,
        playerId: res.ids.get(r.username!.trim().toLowerCase())!,
        type: r.type!,
        amount: Math.round(Number(r.amount) * 100) / 100,
        txnAt: fromLocalInput(r.time!),
        channelId: r.channel ? (chByName.get(r.channel.trim().toLowerCase()) ?? null) : null,
        ref: r.ref?.trim() || null,
        note: r.note?.trim()?.slice(0, 250) || null,
        payBank: r.payBank?.trim().slice(0, 80) || null,
        payAccount: r.payAccount?.trim().slice(0, 60) || null,
        createdById: user.id,
        importId: batchId,
      }));
      // Without a reference, a row is a duplicate if the same player already has the same type and amount at the same minute.
      const playerIds = [...new Set(data.map((d) => d.playerId))];
      const times = data.map((d) => d.txnAt.getTime());
      const existing = playerIds.length
        ? await prisma.txn.findMany({
            where: { playerId: { in: playerIds }, txnAt: { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) } },
            select: { playerId: true, type: true, amount: true, txnAt: true },
          })
        : [];
      const key = (d: { playerId: number; type: string; amount: unknown; txnAt: Date }) => `${d.playerId}|${d.type}|${Number(d.amount).toFixed(2)}|${d.txnAt.getTime()}`;
      const have = new Set(existing.map(key));
      const fresh = data.filter((d) => (d.ref ? true : !have.has(key(d))));
      const r = await prisma.txn.createMany({ data: fresh, skipDuplicates: true });
      inserted = r.count;
      skipped = ok.length - r.count;
      await refreshPlayerStats(playerIds);
      await safely("import", () => trackPlayers(playerIds, fresh.map((d) => d.txnAt)));
    }

    if (kind === "claim") {
      const promos = await prisma.promotion.findMany({ where: { brandId } });
      const byName = new Map(promos.map((p) => [p.name.toLowerCase(), p.id]));
      const ok = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r, i }) => {
          if (!r.username?.trim()) return bad(i, "no username"), false;
          if (!r.promo?.trim()) return bad(i, "no promotion"), false;
          if (!(Number(r.amount) >= 0)) return bad(i, "amount not valid"), false;
          if (!r.time || !TIME.test(r.time)) return bad(i, "date/time not recognised"), false;
          return true;
        });
      for (const name of new Set(ok.map(({ r }) => r.promo!.trim()))) {
        if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), (await prisma.promotion.create({ data: { brandId, name } })).id);
      }
      const res = await ensurePlayers(brandId, ok.map(({ r }) => ({ username: r.username! })), batchId);
      created = res.created;
      const data = ok.map(({ r }) => ({
        promotionId: byName.get(r.promo!.trim().toLowerCase())!,
        playerId: res.ids.get(r.username!.trim().toLowerCase())!,
        amount: Math.round(Number(r.amount) * 100) / 100,
        claimedAt: fromLocalInput(r.time!),
        createdById: user.id,
        importId: batchId,
      }));
      const times = data.map((d) => d.claimedAt.getTime());
      const existing = data.length
        ? await prisma.promoClaim.findMany({
            where: { playerId: { in: [...new Set(data.map((d) => d.playerId))] }, claimedAt: { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) } },
            select: { playerId: true, promotionId: true, amount: true, claimedAt: true },
          })
        : [];
      const key = (d: { playerId: number; promotionId: number; amount: unknown; claimedAt: Date }) => `${d.playerId}|${d.promotionId}|${Number(d.amount).toFixed(2)}|${d.claimedAt.getTime()}`;
      const have = new Set(existing.map(key));
      const fresh = data.filter((d) => !have.has(key(d)));
      inserted = (await prisma.promoClaim.createMany({ data: fresh })).count;
      await safely("import claims", () => linkClaims({ importId: batchId }));
      skipped = ok.length - inserted;
    }

    if (kind === "box") {
      const promos = await prisma.promotion.findMany({ where: { brandId } });
      const byName = new Map(promos.map((p) => [p.name.toLowerCase(), p]));
      const ok = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r, i }) => {
          if (!r.username?.trim()) return bad(i, "no username"), false;
          if (!r.promo?.trim()) return bad(i, "no promotion"), false;
          if (!(Number(r.amount) > 0)) return bad(i, "amount not valid"), false;
          if (!r.time || !TIME.test(r.time)) return bad(i, "date/time not recognised"), false;
          return true;
        });
      for (const name of new Set(ok.map(({ r }) => r.promo!.trim()))) {
        const p = byName.get(name.toLowerCase());
        const box = DEFAULT_BOX as unknown as Prisma.InputJsonValue;
        if (!p) byName.set(name.toLowerCase(), await prisma.promotion.create({ data: { brandId, name, box } }));
        else if (!p.box) byName.set(name.toLowerCase(), await prisma.promotion.update({ where: { id: p.id }, data: { box } }));
      }
      const res = await ensurePlayers(brandId, ok.map(({ r }) => ({ username: r.username! })), batchId);
      created = res.created;
      const data = ok.map(({ r }) => ({
        brandId,
        promotionId: byName.get(r.promo!.trim().toLowerCase())!.id,
        playerId: res.ids.get(r.username!.trim().toLowerCase())!,
        kind: "IN" as const,
        amount: Math.round(Number(r.amount) * 100) / 100,
        at: fromLocalInput(r.time!),
        note: r.note?.trim()?.slice(0, 250) || null,
        createdById: user.id,
        importId: batchId,
      }));
      // Re-importing the same file: same player, promotion, amount and time is skipped.
      const times = data.map((d) => d.at.getTime());
      const existing = data.length
        ? await prisma.boxEntry.findMany({
            where: { kind: "IN", playerId: { in: [...new Set(data.map((d) => d.playerId))] }, at: { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) } },
            select: { playerId: true, promotionId: true, amount: true, at: true },
          })
        : [];
      const key = (d: { playerId: number; promotionId: number; amount: unknown; at: Date }) => `${d.playerId}|${d.promotionId}|${Number(d.amount).toFixed(2)}|${d.at.getTime()}`;
      const have = new Set(existing.map(key));
      const fresh = data.filter((d) => !have.has(key(d)));
      inserted = (await prisma.boxEntry.createMany({ data: fresh })).count;
      await safely("import box", () => trackBoxes([...new Set(fresh.map((d) => d.playerId))]));
      skipped = ok.length - inserted;
    }

    await prisma.importBatch.update({ where: { id: batchId }, data: { inserted: { increment: inserted }, skipped: { increment: skipped + problems.length } } });
    return { inserted, skipped, created, problems, newChannels };
  } catch (e) {
    const msg = e instanceof Denied || e instanceof UserError ? t(e.message) : t("Something went wrong while importing this part of the file.");
    if (!(e instanceof Denied || e instanceof UserError)) console.error(e);
    return { inserted: 0, skipped: 0, created: 0, problems: [], newChannels: [], error: msg };
  }
}

export async function finishImport(batchId: number) {
  const b = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId }, include: { brand: true } });
  const { user } = await access(b.brandId);
  await audit(user, "IMPORT", "ImportBatch", b.id, b.brandId, `Imported ${b.inserted} ${KIND_LABEL[b.kind as ImportKind] ?? b.kind} into ${b.brand.name} from ${b.filename}`, {
    total: b.total,
    inserted: b.inserted,
    skipped: b.skipped,
  });
  revalidatePath("/import");
}

export async function undoImport(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("import", 3);
    const id = int(fd, "id");
    const b = await prisma.importBatch.findUniqueOrThrow({ where: { id } });
    assertBrand(user, b.brandId);
    need(!b.undoneAt, "This import was already undone.");
    let removed = 0;
    if (b.kind === "txn") {
      const affected = await prisma.txn.findMany({ where: { importId: id }, select: { playerId: true, txnAt: true } });
      removed = (await prisma.txn.deleteMany({ where: { importId: id } })).count;
      const pids = [...new Set(affected.map((a) => a.playerId))];
      await refreshPlayerStats(pids);
      await safely("undo import", () => trackPlayers(pids, affected.map((a) => a.txnAt)));
    } else if (b.kind === "claim") {
      await safely("undo claims", () => unlinkClaims({ importId: id }));
      removed = (await prisma.promoClaim.deleteMany({ where: { importId: id } })).count;
    } else if (b.kind === "box") {
      const pids = [...new Set((await prisma.boxEntry.findMany({ where: { importId: id }, select: { playerId: true } })).map((x) => x.playerId))];
      removed = (await prisma.boxEntry.deleteMany({ where: { importId: id } })).count;
      await safely("undo box", () => trackBoxes(pids));
    }
    // Players created by this import go too, unless something else now refers to them.
    const players = await prisma.player.deleteMany({ where: { importId: id, txns: { none: {} }, claims: { none: {} }, contacts: { none: {} }, boxes: { none: {} } } });
    if (b.kind === "player") removed = players.count;
    await prisma.importBatch.update({ where: { id }, data: { undoneAt: new Date() } });
    await audit(user, "UNDO", "ImportBatch", id, b.brandId, `Undid import of ${b.filename} (${removed} rows removed)`);
    revalidatePath("/import");
    const t = await getT();
    return t("Import undone: {n} rows removed.", { n: removed }) + (b.kind !== "player" && players.count ? " " + t("Also removed {n} players it had created.", { n: players.count }) : "");
  });
}

export async function deleteTemplate(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("import", 3);
    const t = await prisma.importTemplate.delete({ where: { id: int(fd, "id") } });
    await audit(user, "DELETE", "ImportTemplate", t.id, null, `Deleted import template ${t.name}`);
    revalidatePath("/import");
    return "Template deleted.";
  });
}

export async function renameTemplate(_p: Result, fd: FormData) {
  return run(async () => {
    await guard("import", 3);
    const name = str(fd, "name");
    if (!name) throw new UserError("Name can't be empty.");
    await prisma.importTemplate.update({ where: { id: int(fd, "id") }, data: { name } });
    revalidatePath("/import");
  });
}
