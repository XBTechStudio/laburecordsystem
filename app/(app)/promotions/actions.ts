"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { assertBrand, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, str, type Result } from "@/lib/action";
import { dateOnly } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { safely, trackPromotion } from "@/lib/promo-engine";
import { readRule } from "@/lib/promo-rule";
import { readBox } from "@/lib/box-rule";
import { trackBoxes } from "@/lib/lucky-box";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function savePromotion(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("promotions", 3);
    const id = Number(str(fd, "id")) || null;
    const name = str(fd, "name");
    const note = str(fd, "note").slice(0, 250) || null;
    need(name, "Please enter the promotion name.");
    if (id) {
      const p = await prisma.promotion.findUniqueOrThrow({ where: { id } });
      assertBrand(user, p.brandId);
      await prisma.promotion.update({ where: { id }, data: { name, note } });
      await audit(user, "UPDATE", "Promotion", id, p.brandId, `Renamed promotion ${p.name} → ${name}`);
    } else {
      // One promotion per brand ticked; each brand keeps its own figures.
      const brandIds = [...new Set(fd.getAll("brandId").map(Number).filter(Number.isInteger))];
      need(brandIds.length, "Choose at least one brand.");
      for (const brandId of brandIds) assertBrand(user, brandId);
      for (const brandId of brandIds) {
        const p = await prisma.promotion.create({ data: { brandId, name, note } });
        await audit(user, "CREATE", "Promotion", p.id, brandId, `Added promotion ${name}`);
      }
    }
    revalidatePath("/promotions");
    return "Promotion saved.";
  });
}

export async function togglePromotion(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("promotions", 3);
    const p = await prisma.promotion.findUniqueOrThrow({ where: { id: int(fd, "id") } });
    assertBrand(user, p.brandId);
    await prisma.promotion.update({ where: { id: p.id }, data: { active: !p.active } });
    await safely("toggle", () => trackPromotion(p.id));
    await audit(user, "UPDATE", "Promotion", p.id, p.brandId, `${p.active ? "Ended" : "Restarted"} promotion ${p.name}`);
    revalidatePath("/promotions");
  });
}

/** Claim conditions the system tracks for a promotion (or none: only analysed from its claims). */
export async function saveConditions(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("promotions", 3);
    const p = await prisma.promotion.findUniqueOrThrow({ where: { id: int(fd, "id") } });
    assertBrand(user, p.brandId);
    const raw = str(fd, "rule");
    let rule = null;
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        need(false, "The conditions couldn't be read. Please try again.");
      }
      rule = readRule(parsed);
      need(rule && rule.tiers.length, "Add at least one tier with its condition filled in.");
      need(rule.basis === "amount" || rule.tiers.every((t) => t.count > 0), "Each tier needs a number of deposits.");
      need(rule.basis === "count" || rule.tiers.every((t) => t.amount > 0), "Each tier needs a total amount.");
      need(rule.tiers.every((t) => t.bonus > 0 || t.pct > 0), "Each tier needs a bonus (an amount or a %).");
    }
    const start = str(fd, "startDay");
    const end = str(fd, "endDay");
    need(!start || !end || start <= end, "The end date is before the start date.");
    await prisma.promotion.update({
      where: { id: p.id },
      data: {
        rule: rule ? (rule as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        startDay: rule && DAY.test(start) ? dateOnly(start) : null,
        endDay: rule && DAY.test(end) ? dateOnly(end) : null,
      },
    });
    await audit(user, "UPDATE", "Promotion", p.id, p.brandId, rule ? `Set tracking conditions for ${p.name}` : `Stopped tracking ${p.name}`, { before: p.rule, after: rule });
    // Recount this period's players with the new conditions.
    await safely("conditions", () => trackPromotion(p.id));
    revalidatePath("/promotions", "layout");
    revalidatePath("/alerts");
    return rule ? "Conditions saved. Players' progress has been recounted." : "Tracking turned off for this promotion.";
  });
}

/** Lucky Box release rules (or not a Lucky Box promotion any more). */
export async function saveBoxRule(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("promotions", 3);
    const p = await prisma.promotion.findUniqueOrThrow({ where: { id: int(fd, "id") } });
    assertBrand(user, p.brandId);
    const on = fd.get("enabled") === "on";
    const rule = on
      ? readBox({ minNetWin: str(fd, "minNetWin"), minDeposit: str(fd, "minDeposit"), releaseCap: str(fd, "releaseCap"), expiryDays: str(fd, "expiryDays"), notify: fd.get("notify") === "on" })
      : null;
    await prisma.promotion.update({ where: { id: p.id }, data: { box: rule ? (rule as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
    await audit(user, "UPDATE", "Promotion", p.id, p.brandId, rule ? `Set Lucky Box rules for ${p.name}` : `Turned off Lucky Box for ${p.name}`, { before: p.box, after: rule });
    const players = (await prisma.boxEntry.findMany({ where: { promotionId: p.id }, select: { playerId: true }, distinct: ["playerId"] })).map((x) => x.playerId);
    if (!rule) await prisma.alert.updateMany({ where: { kind: "BOX", promotionId: p.id, doneAt: null }, data: { doneAt: new Date(), outcome: "auto" } });
    else await safely("box rule", () => trackBoxes(players));
    revalidatePath("/promotions");
    revalidatePath("/lucky-box");
    revalidatePath("/alerts");
    return rule ? "Lucky Box rules saved. Boxes have been checked again." : "Lucky Box turned off for this promotion.";
  });
}
