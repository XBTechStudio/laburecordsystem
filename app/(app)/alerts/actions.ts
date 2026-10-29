"use server";

import { revalidatePath } from "next/cache";
import { assertBrand, can, Denied, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";
import { linkClaims, safely } from "@/lib/promo-engine";

async function mine(id: number) {
  const user = await guard("alerts", 2);
  const a = await prisma.alert.findUniqueOrThrow({ where: { id }, include: { player: true, promotion: true } });
  assertBrand(user, a.brandId);
  // Without Full access, only alerts addressed to you or to the whole brand.
  if (a.staffId && a.staffId !== user.id && !can(user, "alerts", 3)) throw new Denied("This alert belongs to another CS.");
  return { user, a };
}

function revalidate() {
  revalidatePath("/alerts");
  revalidatePath("/promotions", "layout");
}

export async function dismissAlert(_p: Result, fd: FormData) {
  return run(async () => {
    const { user, a } = await mine(int(fd, "id"));
    await prisma.alert.update({ where: { id: a.id }, data: { doneAt: new Date(), doneById: user.id, outcome: "dismissed" } });
    revalidate();
    return "Dismissed.";
  });
}

/** The player received the bonus: record the claim (as if entered under Data entry) and close the alert. */
export async function claimAlert(_p: Result, fd: FormData) {
  return run(async () => {
    const { user, a } = await mine(int(fd, "id"));
    need(a.awardId, "This alert isn't about a bonus.");
    const award = await prisma.promoAward.findUnique({ where: { id: a.awardId } });
    need(award, "This bonus no longer applies (the deposits behind it changed).");
    need(!award.claimedAt, "This bonus is already recorded as claimed.");
    const claim = await prisma.promoClaim.create({
      data: { promotionId: award.promotionId, playerId: award.playerId, amount: award.bonus, claimedAt: new Date(), createdById: user.id },
    });
    await prisma.promoAward.update({ where: { id: award.id }, data: { claimedAt: claim.claimedAt, claimId: claim.id } });
    await prisma.alert.updateMany({ where: { awardId: award.id, doneAt: null }, data: { doneAt: new Date(), doneById: user.id, outcome: "claimed" } });
    await safely("claim", () => linkClaims({ id: claim.id }));
    await audit(user, "CREATE", "PromoClaim", claim.id, a.brandId, `Recorded claim of ${award.bonus} (${a.promotion?.name}) for ${a.player.username} from an alert`);
    revalidate();
    revalidatePath("/entry");
    return "Claim recorded.";
  });
}

/** Hand an alert to someone (Full access) or take it yourself. */
export async function assignAlert(_p: Result, fd: FormData) {
  return run(async () => {
    const { user, a } = await mine(int(fd, "id"));
    const to = Number(fd.get("staffId")) || null;
    need(to === user.id || can(user, "alerts", 3), "Only a supervisor can hand alerts to someone else.");
    await prisma.alert.update({ where: { id: a.id }, data: { staffId: to } });
    revalidate();
    return to === user.id ? "Assigned to you." : "Assigned.";
  });
}
