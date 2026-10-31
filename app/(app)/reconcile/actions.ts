"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { MoveKind } from "@prisma/client";
import { guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { amount, int, need, run, str, type Result } from "@/lib/action";
import { expectedBalances } from "@/lib/balances";
import { fromLocalInput, todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { money, n } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";
import { LOAN_KINDS, LOAN_SIGN, type LoanKind } from "@/lib/move-kinds";
import { checkStatementUrl, syncStatements } from "@/lib/statements";

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const when = (fd: FormData) => (TIME.test(str(fd, "time")) ? fromLocalInput(str(fd, "time")) : new Date());

function refresh(channelId?: number) {
  revalidatePath("/reconcile");
  revalidatePath("/reconcile/loans");
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
        { channelId: from, kind: "TRANSFER_OUT", amount: -amt, at, transferRef: ref, note, userName: user.name },
        { channelId: to, kind: "TRANSFER_IN", amount: amt, at, transferRef: ref, note, userName: user.name },
        // The fee is its own line, so settlement fees can be added up per account.
        ...(fee > 0 ? [{ channelId: from, kind: (a.type === "PG" ? "SETTLE_FEE" : "FEE") as MoveKind, amount: -fee, at, transferRef: ref, note, userName: user.name }] : []),
      ],
    });
    await audit(user, "CREATE", "ChannelMove", ref, null, `Transfer ${amt} from ${a.name} to ${b.name}${fee ? ` (fee ${fee})` : ""}`);
    refresh();
    return "Transfer recorded.";
  });
}

const SIGN: Record<string, 1 | -1> = { TOPUP: 1, CASHOUT: -1, FEE: -1, SETTLE_FEE: -1 };

export async function recordMove(_p: Result, fd: FormData) {
  return run(async () => {
    const kind = str(fd, "kind") as MoveKind;
    const user = await guard("reconcile", kind === "ADJUST" ? 3 : 2);
    const channelId = int(fd, "channelId");
    const amt = amount(str(fd, "amount"));
    need(["TOPUP", "CASHOUT", "FEE", "SETTLE_FEE", "ADJUST"].includes(kind), "Choose what kind of movement this is.");
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

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Money sold to or bought from a money changer (钱庄). The rate is the price of 1 unit of the other currency in this
 * account's currency, so the other side gets amount ÷ rate. If the other currency lands in (or comes from) one of our
 * own accounts, that account gets the matching line too.
 */
export async function recordExchange(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 2);
    const channelId = int(fd, "channelId");
    const out = str(fd, "dir") !== "IN";
    const party = str(fd, "party").slice(0, 80);
    const amt = amount(str(fd, "amount"));
    const rate = amount(str(fd, "rate"));
    const otherId = Number(str(fd, "otherId")) || null;
    need(party, "Enter the money changer's name.");
    need(amt > 0, "Amount must be more than 0.");
    need(rate > 0, "Enter the exchange rate.");
    need(otherId !== channelId, "Choose two different accounts.");
    const [c, other] = await Promise.all([prisma.payChannel.findUniqueOrThrow({ where: { id: channelId } }), otherId ? prisma.payChannel.findUniqueOrThrow({ where: { id: otherId } }) : null]);
    const otherCurrency = (other?.currency ?? str(fd, "otherCurrency")).toUpperCase().slice(0, 10);
    need(/^[A-Z0-9]{2,10}$/.test(otherCurrency), "Enter the other currency, e.g. USDT.");
    const otherAmount = r2(amt / rate);
    const at = when(fd);
    const note = str(fd, "note") || null;
    const ref = other ? randomBytes(8).toString("hex") : null;
    await prisma.channelMove.createMany({
      data: [
        { channelId, kind: out ? "EXCHANGE_OUT" : "EXCHANGE_IN", amount: out ? -amt : amt, at, party, rate, otherAmount, otherCurrency, transferRef: ref, note, userName: user.name },
        ...(other
          ? [
              {
                channelId: other.id,
                kind: (out ? "EXCHANGE_IN" : "EXCHANGE_OUT") as MoveKind,
                amount: out ? otherAmount : -otherAmount,
                at,
                party,
                rate: Math.round((otherAmount / amt) * 1e6) / 1e6,
                otherAmount: amt,
                otherCurrency: c.currency,
                transferRef: ref,
                note,
                userName: user.name,
              },
            ]
          : []),
      ],
    });
    await audit(user, "CREATE", "ChannelMove", channelId, null, `${out ? "Sold" : "Bought"} ${amt} ${c.currency} ${out ? "to" : "from"} ${party} at ${rate} (${otherAmount} ${otherCurrency})`);
    refresh(channelId);
    if (other) revalidatePath(`/reconcile/${other.id}`);
    const t = await getT();
    return t("Saved: {amount} {cur} at {rate}.", { amount: otherAmount.toFixed(2), cur: otherCurrency, rate });
  });
}

/** Lending between operators (同行互借). Lending and paying back move money out; borrowing and being paid back move it in. */
export async function recordLoan(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 2);
    const kind = str(fd, "kind") as LoanKind;
    const channelId = int(fd, "channelId");
    const party = str(fd, "party").slice(0, 80);
    const amt = amount(str(fd, "amount"));
    need(LOAN_KINDS.includes(kind), "Choose what kind of movement this is.");
    need(party, "Enter the other operator's name.");
    need(amt > 0, "Amount must be more than 0.");
    const c = await prisma.payChannel.findUniqueOrThrow({ where: { id: channelId } });
    await prisma.channelMove.create({ data: { channelId, kind, amount: amt * LOAN_SIGN[kind], at: when(fd), party, note: str(fd, "note") || null, userName: user.name } });
    await audit(user, "CREATE", "ChannelMove", channelId, null, `${kind} ${amt} ${c.currency} with ${party} on ${c.name}`);
    refresh(channelId);
    revalidatePath("/reconcile/loans");
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
    need(/^[A-Z]{3,5}$/.test(currency), "Currency should be a code like MYR, AUD or USDT.");
    const statementUrl = str(fd, "statementUrl") ? checkStatementUrl(str(fd, "statementUrl")) : null;
    const before = await prisma.payChannel.findUniqueOrThrow({ where: { id } });
    const newLink = statementUrl !== before.statementUrl;
    await prisma.payChannel.update({
      where: { id },
      data: {
        openingBalance: bal,
        openingAt: at,
        feePercent,
        feeFixed,
        currency,
        type: str(fd, "type") === "PG" ? "PG" : "BANK",
        feeAtSettlement: fd.get("feeAtSettlement") === "on",
        statementUrl,
        ...(newLink ? { statementError: null, statementReadAt: null } : {}),
      },
    });
    await audit(user, "UPDATE", "PayChannel", id, null, `Starting balance of ${before.name} set to ${bal}`, {
      before: { openingBalance: before.openingBalance, openingAt: before.openingAt, statementUrl: before.statementUrl },
      after: { openingBalance: bal, openingAt: at, statementUrl },
    });
    refresh(id);
    // Try a new link straight away, so a wrong one shows up now rather than later.
    if (statementUrl && newLink) {
      const r = await syncStatements(todayStr(), [id]);
      revalidatePath("/reconcile/statements", "layout");
      if (r.failed) {
        const t = await getT();
        const err = (await prisma.payChannel.findUnique({ where: { id }, select: { statementError: true } }))?.statementError;
        return { message: t("Account saved, but the statement page couldn't be read: {reason}", { reason: t(err ?? "") }), warn: true };
      }
      if (r.read) return "Account saved. Today's statement was read.";
      return "Account saved. The statement page has nothing for today yet.";
    }
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
