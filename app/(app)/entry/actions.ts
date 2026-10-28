"use server";

import { revalidatePath } from "next/cache";
import type { TxnType } from "@prisma/client";
import { assertBrand, Denied, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { amount, int, need, run, str, UserError, type Result } from "@/lib/action";
import { dateOnly, fromLocalInput, todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { editRights } from "@/lib/edit-rights";
import { phoneKey } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { ensurePlayers, refreshPlayerStats } from "@/lib/players";

type Row = Record<string, string>;
type Err = { i: number; msg: string };
export type BatchResult = { ok: boolean; message: string; errors?: Err[] };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** "Now" on the default date if it's today, otherwise noon on that date. */
function defaultTime(defaultDate: string) {
  if (defaultDate === todayStr()) return new Date();
  return fromLocalInput(`${defaultDate}T12:00`);
}

function when(v: string | undefined, defaultDate: string): Date | null {
  const s = (v ?? "").trim();
  if (!s) return defaultTime(defaultDate);
  if (TIME.test(s)) return fromLocalInput(s);
  if (DAY.test(s)) return fromLocalInput(`${s}T12:00`);
  return null;
}

function day(v: string | undefined, defaultDate: string): string | null {
  const s = (v ?? "").trim() || defaultDate;
  return DAY.test(s) ? s : null;
}

const pos = (v: string | undefined) => {
  const x = amount(v ?? "");
  return Number.isFinite(x) && x >= 0 ? Math.abs(x) : NaN;
};

/** Expense rows need the Expenses permission (salaries are sensitive); everything else needs Data entry. */
const moduleFor = (kind: string) => (kind === "expense" ? ("expenses" as const) : ("entry" as const));

async function brandOk(brandId: number, kind: string) {
  const user = await guard(moduleFor(kind), 2);
  assertBrand(user, brandId);
  const b = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!b || !b.active) throw new Denied("This brand is not active.");
  return { user, brand: b };
}

export async function loadLists(kind: string, brandId: number) {
  await brandOk(brandId, kind);
  const out: Record<string, string[]> = {};
  if (kind === "txn" || kind === "claim") {
    const ps = await prisma.player.findMany({ where: { brandId }, select: { username: true }, orderBy: { lastDepositAt: "desc" }, take: 20000 });
    out.players = ps.map((p) => p.username);
  }
  if (kind === "claim") {
    const pr = await prisma.promotion.findMany({ where: { brandId, active: true }, select: { name: true }, orderBy: { name: "asc" } });
    out.promos = pr.map((p) => p.name);
  }
  return out;
}

export async function saveBatch(kind: string, brandId: number, rows: Row[], defaultDate: string): Promise<BatchResult> {
  const t = await getT();
  try {
    const { user, brand } = await brandOk(brandId, kind);
    need(rows.length <= 2000, "Up to 2,000 rows at a time, please. For bigger files use Excel import.");
    need(DAY.test(defaultDate), "Please set a valid default date.");
    const errors: Err[] = [];
    const fail = (i: number, msg: string, vars?: Record<string, string | number>) => errors.push({ i, msg: t(msg, vars) });
    const done = (message: string): BatchResult => {
      revalidatePath("/entry");
      revalidatePath("/expenses");
      return { ok: true, message };
    };
    const NOTHING = t("Nothing was saved. Please fix the rows below.");

    if (kind === "txn") {
      const parsed = rows.map((r, i) => {
        const type: TxnType | null = r.type === "WITHDRAW" ? "WITHDRAW" : r.type === "DEPOSIT" ? "DEPOSIT" : null;
        const amt = pos(r.amount);
        const at = when(r.time, defaultDate);
        if (!r.player?.trim()) fail(i, "Player is missing");
        else if (!type) fail(i, "Choose Deposit or Withdrawal");
        else if (!(amt > 0)) fail(i, "Amount must be more than 0");
        else if (!at) fail(i, "Date/time isn't valid");
        return { username: r.player?.trim() ?? "", type: type as TxnType, amount: amt, txnAt: at!, channelId: Number(r.channel) || null, ref: r.ref?.trim() || null, note: r.note?.trim() || null };
      });
      // Reference numbers must be unique per brand and type, both inside this batch and against what's saved.
      const seen = new Map<string, number>();
      parsed.forEach((p, i) => {
        if (!p.ref) return;
        const k = `${p.type}|${p.ref.toLowerCase()}`;
        if (seen.has(k)) fail(i, "Same reference as row {row}", { row: seen.get(k)! + 1 });
        else seen.set(k, i);
      });
      const refs = parsed.filter((p) => p.ref).map((p) => p.ref!);
      if (refs.length) {
        const dup = await prisma.txn.findMany({ where: { brandId, ref: { in: refs } }, select: { ref: true, type: true } });
        const taken = new Set(dup.map((d) => `${d.type}|${d.ref!.toLowerCase()}`));
        parsed.forEach((p, i) => p.ref && taken.has(`${p.type}|${p.ref.toLowerCase()}`) && fail(i, "Reference {ref} was already entered", { ref: p.ref }));
      }
      if (errors.length) return { ok: false, message: NOTHING, errors };

      const { ids, created } = await ensurePlayers(brandId, parsed.map((p) => ({ username: p.username })));
      await prisma.txn.createMany({
        data: parsed.map((p) => ({
          brandId,
          playerId: ids.get(p.username.toLowerCase())!,
          type: p.type,
          amount: p.amount,
          txnAt: p.txnAt,
          channelId: p.channelId,
          ref: p.ref,
          note: p.note,
          createdById: user.id,
        })),
      });
      await refreshPlayerStats([...ids.values()]);
      const dep = parsed.filter((p) => p.type === "DEPOSIT");
      const wd = parsed.filter((p) => p.type === "WITHDRAW");
      await audit(user, "CREATE", "Txn", null, brandId, `Entered ${dep.length} deposits and ${wd.length} withdrawals for ${brand.name}`, {
        deposits: dep.reduce((a, p) => a + p.amount, 0),
        withdrawals: wd.reduce((a, p) => a + p.amount, 0),
        newPlayers: created,
      });
      return done(t("Saved {n} transactions.", { n: parsed.length }) + (created ? " " + t("{n} new players added.", { n: created }) : ""));
    }

    if (kind === "claim") {
      const promos = await prisma.promotion.findMany({ where: { brandId } });
      const byName = new Map(promos.map((p) => [p.name.toLowerCase(), p]));
      const parsed = rows.map((r, i) => {
        const amt = pos(r.amount);
        const at = when(r.time, defaultDate);
        if (!r.player?.trim()) fail(i, "Player is missing");
        else if (!r.promo?.trim()) fail(i, "Promotion is missing");
        else if (!(amt >= 0) || Number.isNaN(amt)) fail(i, "Amount isn't valid");
        else if (!at) fail(i, "Date/time isn't valid");
        return { username: r.player?.trim() ?? "", promo: r.promo?.trim() ?? "", amount: amt, claimedAt: at! };
      });
      if (errors.length) return { ok: false, message: NOTHING, errors };
      const newNames = [...new Set(parsed.map((p) => p.promo).filter((n) => !byName.has(n.toLowerCase())))];
      for (const name of newNames) {
        const p = await prisma.promotion.create({ data: { brandId, name } });
        byName.set(name.toLowerCase(), p);
      }
      const { ids, created } = await ensurePlayers(brandId, parsed.map((p) => ({ username: p.username })));
      await prisma.promoClaim.createMany({
        data: parsed.map((p) => ({
          promotionId: byName.get(p.promo.toLowerCase())!.id,
          playerId: ids.get(p.username.toLowerCase())!,
          amount: p.amount,
          claimedAt: p.claimedAt,
          createdById: user.id,
        })),
      });
      await audit(user, "CREATE", "PromoClaim", null, brandId, `Entered ${parsed.length} promotion claims for ${brand.name}`, { newPromotions: newNames, newPlayers: created });
      return done(
        t("Saved {n} claims.", { n: parsed.length }) +
          (newNames.length ? " " + t("New promotions created: {names}.", { names: newNames.join(", ") }) : "") +
          (created ? " " + t("{n} new players added.", { n: created }) : ""),
      );
    }

    if (kind === "expense") {
      const cats = new Map((await prisma.expenseCategory.findMany({ where: { active: true } })).map((c) => [c.id, c]));
      const parsed = rows.map((r, i) => {
        const cat = cats.get(Number(r.category));
        const d = day(r.date, defaultDate);
        const amt = pos(r.amount);
        if (!cat) fail(i, "Choose a category");
        else if (!d) fail(i, "Date isn't valid");
        else if (!(amt > 0)) fail(i, "Amount must be more than 0");
        return { categoryId: cat?.id ?? 0, date: d ?? "", amount: amt, note: r.note?.trim() || null };
      });
      if (errors.length) return { ok: false, message: NOTHING, errors };
      await prisma.expense.createMany({ data: parsed.map((p) => ({ brandId, categoryId: p.categoryId, date: dateOnly(p.date), amount: p.amount, note: p.note, createdById: user.id })) });
      await audit(user, "CREATE", "Expense", null, brandId, `Entered ${parsed.length} expense/income rows for ${brand.name}`, {
        total: parsed.reduce((a, p) => a + p.amount, 0),
      });
      return done(t("Saved {n} rows.", { n: parsed.length }));
    }

    if (kind === "player") {
      const parsed = rows.map((r, i) => {
        if (!r.username?.trim()) fail(i, "Username is missing");
        return { username: r.username?.trim() ?? "", phone: r.phone?.trim() || null, name: r.name?.trim() || null, note: r.note?.trim() || null };
      });
      if (errors.length) return { ok: false, message: NOTHING, errors };
      const { ids, created } = await ensurePlayers(brandId, parsed);
      // Rows for existing players update their details.
      for (const p of parsed) {
        const id = ids.get(p.username.toLowerCase());
        if (!id) continue;
        await prisma.player.update({
          where: { id },
          data: {
            ...(p.phone ? { phone: p.phone, phoneKey: phoneKey(p.phone) } : {}),
            ...(p.name ? { name: p.name } : {}),
            ...(p.note ? { note: p.note } : {}),
          },
        });
      }
      await audit(user, "CREATE", "Player", null, brandId, `Entered ${parsed.length} players for ${brand.name}`, { created });
      return done(t("Saved {n} players ({created} new, {updated} updated).", { n: parsed.length, created, updated: parsed.length - created }));
    }

    return { ok: false, message: t("Unknown entry type.") };
  } catch (e) {
    if (e instanceof Denied || e instanceof UserError) return { ok: false, message: t(e.message) };
    console.error(e);
    return { ok: false, message: t("Something went wrong. Nothing was saved.") };
  }
}

// ---- edit & delete single entries ----

/** Full access may change anything; others only their own entries, and only if Settings give them a few minutes to fix typos. */
async function mayChange(createdById: number | null, createdAt: Date, brandId: number, kind = "entry") {
  const m = moduleFor(kind);
  const user = await guard(m, 2);
  assertBrand(user, brandId);
  const rights = await editRights(user, m);
  if (!rights.may(createdById, createdAt)) throw new Denied(rights.denied);
  return user;
}

export async function deleteEntry(_p: Result, fd: FormData) {
  return run(async () => {
    const kind = str(fd, "kind");
    const id = int(fd, "id");
    if (kind === "txn") {
      const t = await prisma.txn.findUniqueOrThrow({ where: { id }, include: { player: true } });
      const user = await mayChange(t.createdById, t.createdAt, t.brandId);
      await prisma.txn.delete({ where: { id } });
      await refreshPlayerStats([t.playerId]);
      await audit(user, "DELETE", "Txn", id, t.brandId, `Deleted ${t.type.toLowerCase()} of ${t.amount} for ${t.player.username}`, t);
    } else if (kind === "claim") {
      const c = await prisma.promoClaim.findUniqueOrThrow({ where: { id }, include: { promotion: true } });
      const user = await mayChange(c.createdById, c.createdAt, c.promotion.brandId);
      await prisma.promoClaim.delete({ where: { id } });
      await audit(user, "DELETE", "PromoClaim", id, c.promotion.brandId, `Deleted claim of ${c.amount} (${c.promotion.name})`, c);
    } else if (kind === "expense") {
      const e = await prisma.expense.findUniqueOrThrow({ where: { id }, include: { category: true } });
      const user = await mayChange(e.createdById, e.createdAt, e.brandId, "expense");
      await prisma.expense.delete({ where: { id } });
      await audit(user, "DELETE", "Expense", id, e.brandId, `Deleted ${e.category.name} of ${e.amount}`, e);
    } else if (kind === "player") {
      const p = await prisma.player.findUniqueOrThrow({ where: { id }, include: { _count: { select: { txns: true, claims: true, contacts: true } } } });
      const user = await guard("entry", 3);
      assertBrand(user, p.brandId);
      need(!p._count.txns && !p._count.claims && !p._count.contacts, "This player has transactions, claims or contact history, so it can't be deleted.");
      await prisma.player.delete({ where: { id } });
      await audit(user, "DELETE", "Player", id, p.brandId, `Deleted player ${p.username}`, p);
    }
    revalidatePath("/entry");
    revalidatePath("/expenses");
    revalidatePath("/transactions");
    return "Deleted.";
  });
}

export async function updateEntry(_p: Result, fd: FormData) {
  return run(async () => {
    const kind = str(fd, "kind");
    const id = int(fd, "id");
    const time = str(fd, "time");
    const d = str(fd, "date");
    if (kind === "txn") {
      const t = await prisma.txn.findUniqueOrThrow({ where: { id } });
      const user = await mayChange(t.createdById, t.createdAt, t.brandId);
      const data = {
        type: str(fd, "type") === "WITHDRAW" ? ("WITHDRAW" as const) : ("DEPOSIT" as const),
        amount: pos(str(fd, "amount")),
        txnAt: TIME.test(time) ? fromLocalInput(time) : t.txnAt,
        channelId: Number(str(fd, "channel")) || null,
        ref: str(fd, "ref") || null,
        note: str(fd, "note") || null,
      };
      need(data.amount > 0, "Amount must be more than 0.");
      await prisma.txn.update({ where: { id }, data });
      await refreshPlayerStats([t.playerId]);
      await audit(user, "UPDATE", "Txn", id, t.brandId, `Edited ${data.type.toLowerCase()} #${id}`, { before: t, after: data });
    } else if (kind === "claim") {
      const c = await prisma.promoClaim.findUniqueOrThrow({ where: { id }, include: { promotion: true } });
      const user = await mayChange(c.createdById, c.createdAt, c.promotion.brandId);
      const data = { amount: pos(str(fd, "amount")), claimedAt: TIME.test(time) ? fromLocalInput(time) : c.claimedAt };
      need(data.amount >= 0, "Amount isn't valid.");
      await prisma.promoClaim.update({ where: { id }, data });
      await audit(user, "UPDATE", "PromoClaim", id, c.promotion.brandId, `Edited claim #${id}`, { before: c, after: data });
    } else if (kind === "expense") {
      const e = await prisma.expense.findUniqueOrThrow({ where: { id } });
      const user = await mayChange(e.createdById, e.createdAt, e.brandId, "expense");
      const data = { categoryId: int(fd, "category") || e.categoryId, amount: pos(str(fd, "amount")), date: DAY.test(d) ? dateOnly(d) : e.date, note: str(fd, "note") || null };
      need(data.amount > 0, "Amount must be more than 0.");
      await prisma.expense.update({ where: { id }, data });
      await audit(user, "UPDATE", "Expense", id, e.brandId, `Edited expense #${id}`, { before: e, after: data });
    } else if (kind === "player") {
      const p = await prisma.player.findUniqueOrThrow({ where: { id } });
      const user = await guard("entry", 3);
      assertBrand(user, p.brandId);
      const phone = str(fd, "phone") || null;
      const data = { phone, phoneKey: phoneKey(phone), name: str(fd, "name") || null, note: str(fd, "note") || null };
      await prisma.player.update({ where: { id }, data });
      await audit(user, "UPDATE", "Player", id, p.brandId, `Edited player ${p.username}`, { before: p, after: data });
    }
    revalidatePath("/entry");
    revalidatePath("/expenses");
    revalidatePath("/transactions");
    return "Saved.";
  });
}
