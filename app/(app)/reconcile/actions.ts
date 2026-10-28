"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { MoveKind } from "@prisma/client";
import { guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { amount, int, need, run, str, type Result } from "@/lib/action";
import { expectedBalances } from "@/lib/balances";
import { fromLocalInput } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { money, n } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const when = (fd: FormData) => (TIME.test(str(fd, "time")) ? fromLocalInput(str(fd, "time")) : new Date());

function refresh(channelId?: number) {
  revalidatePath("/reconcile");
  if (channelId) revalidatePath(`/reconcile/${channelId}`);
  revalidatePath("/");
}

/** Staff read the real balance from the bank/PG; the system says straight away whether it matches. */
export async function recordBalance(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 2);
    const t = await getT();
    const channelId = int(fd, "channelId");
    const actual = amount(str(fd, "actual"));
    need(Number.isFinite(actual), "Enter the balance shown in the bank or PG.");
    const c = await prisma.payChannel.findUniqueOrThrow({ where: { id: channelId } });
    const at = when(fd);
    const expected = (await expectedBalances(at, [channelId])).get(channelId)?.expected ?? 0;
    const diff = Math.round((actual - expected) * 100) / 100;
    const tol = (await getSettings()).reconTolerance;
    await prisma.balanceCheck.create({ data: { channelId, at, actual, expected, note: str(fd, "note") || null, userName: user.name, resolved: Math.abs(diff) <= tol } });
    await audit(user, "CREATE", "BalanceCheck", channelId, null, `Balance of ${c.name}: ${actual} (system ${expected})`);
    refresh(channelId);
    return Math.abs(diff) <= tol
      ? t("Matched. The system balance is {amount}.", { amount: money(expected, c.currency) })
      : { message: t("Difference of {diff}: the system expected {expected}.", { diff: money(diff, c.currency), expected: money(expected, c.currency) }), warn: true };
  });
}

export async function recordTransfer(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 2);
    const from = int(fd, "from");
    const to = int(fd, "to");
    const amt = amount(str(fd, "amount"));
    const fee = amount(str(fd, "fee") || "0");
    need(Number.isInteger(from) && Number.isInteger(to) && from !== to, "Choose two different accounts.");
    need(amt > 0, "Amount must be more than 0.");
    need(fee >= 0, "Fees can't be negative.");
    const at = when(fd);
    const ref = randomBytes(8).toString("hex");
    const note = str(fd, "note") || null;
    const [a, b] = await Promise.all([prisma.payChannel.findUniqueOrThrow({ where: { id: from } }), prisma.payChannel.findUniqueOrThrow({ where: { id: to } })]);
    await prisma.channelMove.createMany({
      data: [
        { channelId: from, kind: "TRANSFER_OUT", amount: -(amt + fee), at, transferRef: ref, note, userName: user.name },
        { channelId: to, kind: "TRANSFER_IN", amount: amt, at, transferRef: ref, note, userName: user.name },
      ],
    });
    await audit(user, "CREATE", "ChannelMove", ref, null, `Transfer ${amt} from ${a.name} to ${b.name}${fee ? ` (fee ${fee})` : ""}`);
    refresh();
    return "Transfer recorded.";
  });
}

const SIGN: Record<string, 1 | -1> = { TOPUP: 1, CASHOUT: -1, FEE: -1 };

export async function recordMove(_p: Result, fd: FormData) {
  return run(async () => {
    const kind = str(fd, "kind") as MoveKind;
    const user = await guard("reconcile", kind === "ADJUST" ? 3 : 2);
    const channelId = int(fd, "channelId");
    const amt = amount(str(fd, "amount"));
    need(["TOPUP", "CASHOUT", "FEE", "ADJUST"].includes(kind), "Choose what kind of movement this is.");
    need(Number.isFinite(amt) && amt !== 0, "Enter an amount.");
    if (kind !== "ADJUST") need(amt > 0, "Amount must be more than 0.");
    const c = await prisma.payChannel.findUniqueOrThrow({ where: { id: channelId } });
    const value = kind === "ADJUST" ? amt : Math.abs(amt) * SIGN[kind];
    await prisma.channelMove.create({ data: { channelId, kind, amount: value, at: when(fd), note: str(fd, "note") || null, userName: user.name } });
    await audit(user, "CREATE", "ChannelMove", channelId, null, `${kind} ${value} on ${c.name}`);
    refresh(channelId);
    return "Saved.";
  });
}

/** Clear a difference: either book it as an adjustment (the system then agrees with the bank) or just note why. */
export async function resolveCheck(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 3);
    const check = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: int(fd, "id") }, include: { channel: true } });
    const note = str(fd, "note") || null;
    if (str(fd, "mode") === "adjust") {
      const diff = Math.round((n(check.actual) - n(check.expected)) * 100) / 100;
      if (diff !== 0)
        await prisma.channelMove.create({
          data: { channelId: check.channelId, kind: "ADJUST", amount: diff, at: check.at, note: note ?? `Balance check ${check.id}`, userName: user.name },
        });
    }
    await prisma.balanceCheck.update({ where: { id: check.id }, data: { resolved: true, note: note ?? check.note } });
    await audit(user, "UPDATE", "BalanceCheck", check.id, null, `${str(fd, "mode") === "adjust" ? "Booked difference as adjustment" : "Explained difference"} on ${check.channel.name}`, { note });
    refresh(check.channelId);
    return "Saved.";
  });
}

export async function setOpening(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 3);
    const id = int(fd, "channelId");
    const bal = amount(str(fd, "openingBalance") || "0");
    need(Number.isFinite(bal), "Enter the starting balance.");
    const at = TIME.test(str(fd, "openingAt")) ? fromLocalInput(str(fd, "openingAt")) : null;
    const feePercent = amount(str(fd, "feePercent") || "0");
    const feeFixed = amount(str(fd, "feeFixed") || "0");
    const currency = (str(fd, "currency") || "MYR").toUpperCase();
    need(feePercent >= 0 && feeFixed >= 0, "Fees can't be negative.");
    need(/^[A-Z]{3}$/.test(currency), "Currency should be a 3-letter code like MYR or THB.");
    const before = await prisma.payChannel.findUniqueOrThrow({ where: { id } });
    await prisma.payChannel.update({
      where: { id },
      data: { openingBalance: bal, openingAt: at, feePercent, feeFixed, currency, type: str(fd, "type") === "PG" ? "PG" : "BANK", feeAtSettlement: fd.get("feeAtSettlement") === "on" },
    });
    await audit(user, "UPDATE", "PayChannel", id, null, `Starting balance of ${before.name} set to ${bal}`, {
      before: { openingBalance: before.openingBalance, openingAt: before.openingAt },
      after: { openingBalance: bal, openingAt: at },
    });
    refresh(id);
    return "Account saved.";
  });
}

export async function deleteMove(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 3);
    const m = await prisma.channelMove.findUniqueOrThrow({ where: { id: int(fd, "id") }, include: { channel: true } });
    if (m.transferRef) await prisma.channelMove.deleteMany({ where: { transferRef: m.transferRef } });
    else await prisma.channelMove.delete({ where: { id: m.id } });
    await audit(user, "DELETE", "ChannelMove", m.id, null, `Deleted ${m.kind} of ${m.amount} on ${m.channel.name}`, m);
    refresh(m.channelId);
    return "Deleted.";
  });
}

export async function deleteCheck(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 3);
    const c = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: int(fd, "id") }, include: { channel: true } });
    await prisma.balanceCheck.delete({ where: { id: c.id } });
    await audit(user, "DELETE", "BalanceCheck", c.id, null, `Deleted balance check of ${c.channel.name}`, c);
    refresh(c.channelId);
    return "Deleted.";
  });
}
