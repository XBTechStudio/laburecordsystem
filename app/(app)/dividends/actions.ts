"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertBrand, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { amount, int, need, run, str, type Result } from "@/lib/action";
import { addDays, dateOnly } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { n } from "@/lib/format";
import { breakdownOf, previewSettlement } from "@/lib/dividends";
import { getT } from "@/lib/i18n-server";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const refresh = () => revalidatePath("/dividends", "layout");

export async function saveShareholder(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("dividends", 3);
    const id = Number(str(fd, "id")) || null;
    const data = { name: str(fd, "name"), phone: str(fd, "phone") || null, note: str(fd, "note") || null };
    need(data.name, "Please enter the shareholder's name.");
    if (id) {
      await prisma.shareholder.update({ where: { id }, data });
      await audit(user, "UPDATE", "Shareholder", id, null, `Edited shareholder ${data.name}`);
    } else {
      const s = await prisma.shareholder.create({ data });
      await audit(user, "CREATE", "Shareholder", s.id, null, `Added shareholder ${data.name}`);
    }
    refresh();
    return "Saved.";
  });
}

export async function toggleShareholder(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("dividends", 3);
    const s = await prisma.shareholder.findUniqueOrThrow({ where: { id: int(fd, "id") } });
    if (s.active) {
      const open = await prisma.holding.count({ where: { shareholderId: s.id, effectiveTo: null } });
      need(open === 0, (await getT())("{name} still holds shares. Change the brand shares first.", { name: s.name }));
    }
    await prisma.shareholder.update({ where: { id: s.id }, data: { active: !s.active } });
    await audit(user, "UPDATE", "Shareholder", s.id, null, `${s.active ? "Deactivated" : "Reactivated"} shareholder ${s.name}`);
    refresh();
  });
}

/** Replaces a brand's shareholding from a date. Earlier holdings are closed, not changed, so old settlements stay as they were. */
export async function saveShares(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("dividends", 3);
    const brandId = int(fd, "brandId");
    assertBrand(user, brandId);
    const from = str(fd, "from");
    need(DAY.test(from), "Choose the date the new shares start.");
    const entries = [...fd.entries()]
      .filter(([k]) => k.startsWith("pct_"))
      .map(([k, v]) => ({ shareholderId: Number(k.slice(4)), percent: amount(String(v) || "0") }))
      .filter((e) => e.percent !== 0);
    need(entries.every((e) => e.percent > 0 && e.percent <= 100), "Each share must be between 0 and 100%.");
    const total = entries.reduce((a, e) => a + e.percent, 0);
    need(total <= 100.0001, (await getT())("The shares add up to {p}%. They can't be more than 100%.", { p: total }));

    const before = await prisma.holding.findMany({ where: { brandId, effectiveTo: null }, include: { shareholder: true } });
    await prisma.$transaction([
      // Holdings that hadn't started yet are simply replaced; running ones end the day before.
      prisma.holding.deleteMany({ where: { brandId, effectiveTo: null, effectiveFrom: { gte: dateOnly(from) } } }),
      prisma.holding.updateMany({ where: { brandId, effectiveTo: null, effectiveFrom: { lt: dateOnly(from) } }, data: { effectiveTo: dateOnly(addDays(from, -1)) } }),
      prisma.holding.createMany({ data: entries.map((e) => ({ brandId, shareholderId: e.shareholderId, percent: e.percent, effectiveFrom: dateOnly(from) })) }),
    ]);
    await audit(user, "UPDATE", "Holding", brandId, brandId, `Changed shares from ${from} (total ${total}%)`, {
      before: before.map((h) => ({ name: h.shareholder.name, percent: n(h.percent), since: h.effectiveFrom })),
      after: entries,
    });
    refresh();
    const t = await getT();
    return t("Shares saved, starting {date}.", { date: from }) + (total < 100 ? " " + t("{p}% stays with the company.", { p: (100 - total).toFixed(2) }) : "");
  });
}

export async function saveRule(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("dividends", 3);
    const brandId = int(fd, "brandId");
    assertBrand(user, brandId);
    const reserve = amount(str(fd, "reservePercent") || "0");
    need(reserve >= 0 && reserve <= 100, "Reserve must be between 0 and 100%.");
    const data = {
      period: str(fd, "period") === "QUARTERLY" ? ("QUARTERLY" as const) : ("MONTHLY" as const),
      carryLoss: fd.get("carryLoss") === "on",
      reservePercent: reserve,
      deductFees: fd.get("deductFees") === "on",
      deductPromos: fd.get("deductPromos") === "on",
      excludedCategoryIds: fd.getAll("excluded").map(Number).filter(Number.isInteger),
    };
    await prisma.dividendRule.upsert({ where: { brandId }, create: { brandId, ...data }, update: data });
    await audit(user, "UPDATE", "DividendRule", brandId, brandId, "Changed dividend rules", data);
    refresh();
    return "Rules saved. They apply to settlements you run from now on.";
  });
}

export async function createSettlement(_p: Result, fd: FormData) {
  const res = await run(async () => {
    const user = await guard("dividends", 3);
    const brandId = int(fd, "brandId");
    assertBrand(user, brandId);
    const from = str(fd, "from");
    const to = str(fd, "to");
    need(DAY.test(from) && DAY.test(to), "Invalid period.");
    const p = await previewSettlement(brandId, from, to);
    need(!p.overlap, "This period has already been settled.");
    need(!p.unfinished, "This period hasn't finished yet.");
    // Guard against the numbers changing between preview and confirm.
    need(Math.abs(p.distributable - Number(str(fd, "expected"))) < 0.01, "The numbers changed since you opened the preview. Please check them again.");
    const s = await prisma.settlement.create({
      data: {
        brandId,
        periodStart: dateOnly(from),
        periodEnd: dateOnly(to),
        profit: p.profit,
        carriedIn: p.carriedIn,
        reserve: p.reserve,
        distributable: p.distributable,
        carryOut: p.carryOut,
        breakdown: breakdownOf(p),
        createdBy: user.name,
        lines: { create: p.lines.map((l) => ({ shareholderId: l.shareholderId, percent: l.percent, amount: l.amount })) },
      },
    });
    await audit(user, "SETTLE", "Settlement", s.id, brandId, `Settled ${p.brand.name} ${from} to ${to}: ${p.distributable} to distribute`, breakdownOf(p));
    refresh();
    return { message: "Settlement saved.", data: s.id };
  });
  if (res?.ok) redirect(`/dividends/${res.data}`);
  return res;
}

export async function deleteSettlement(_p: Result, fd: FormData) {
  const res = await run(async () => {
    const user = await guard("dividends", 3);
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: int(fd, "id") }, include: { lines: { include: { payments: true } } } });
    assertBrand(user, s.brandId);
    need(s.lines.every((l) => l.payments.length === 0), "Payments have been recorded for this settlement. Remove them first.");
    const later = await prisma.settlement.findFirst({ where: { brandId: s.brandId, periodStart: { gt: s.periodEnd } } });
    need(!later, "A later period is already settled and may depend on this one (carried losses). Delete the later one first.");
    await prisma.settlement.delete({ where: { id: s.id } });
    await audit(user, "DELETE", "Settlement", s.id, s.brandId, `Deleted settlement ${s.periodStart.toISOString().slice(0, 10)} to ${s.periodEnd.toISOString().slice(0, 10)}`);
    refresh();
  });
  if (res?.ok) redirect("/dividends?tab=settlements");
  return res;
}

export async function recordPayment(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("dividends", 3);
    const line = await prisma.settlementLine.findUniqueOrThrow({ where: { id: int(fd, "lineId") }, include: { settlement: true, shareholder: true } });
    assertBrand(user, line.settlement.brandId);
    const amt = amount(str(fd, "amount"));
    const day = str(fd, "paidAt");
    need(amt > 0, "Amount must be more than 0.");
    need(DAY.test(day), "Choose the payment date.");
    const left = n(line.amount) - n(line.paid);
    need(amt <= left + 0.005, (await getT())("Only {amount} is still unpaid to {name}.", { amount: left.toFixed(2), name: line.shareholder.name }));
    await prisma.$transaction([
      prisma.dividendPayment.create({ data: { lineId: line.id, amount: amt, paidAt: dateOnly(day), note: str(fd, "note") || null, userName: user.name } }),
      prisma.settlementLine.update({ where: { id: line.id }, data: { paid: { increment: amt } } }),
    ]);
    await audit(user, "PAY", "SettlementLine", line.id, line.settlement.brandId, `Paid ${amt} to ${line.shareholder.name}`);
    refresh();
    return "Payment recorded.";
  });
}

export async function deletePayment(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("dividends", 3);
    const pay = await prisma.dividendPayment.findUniqueOrThrow({ where: { id: int(fd, "id") }, include: { line: { include: { settlement: true, shareholder: true } } } });
    assertBrand(user, pay.line.settlement.brandId);
    await prisma.$transaction([
      prisma.dividendPayment.delete({ where: { id: pay.id } }),
      prisma.settlementLine.update({ where: { id: pay.lineId }, data: { paid: { decrement: pay.amount } } }),
    ]);
    await audit(user, "DELETE", "DividendPayment", pay.id, pay.line.settlement.brandId, `Removed payment of ${pay.amount} to ${pay.line.shareholder.name}`);
    refresh();
  });
}
