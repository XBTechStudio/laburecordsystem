"use server";

import { revalidatePath } from "next/cache";
import { assertBrand, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";
import { trackBoxes } from "@/lib/lucky-box";
import { linkClaims, safely, unlinkClaims } from "@/lib/promo-engine";

/**
 * Marks a claim as not counted (e.g. a test on the platform), or counts it again. It stays saved, so the platform sync
 * doesn't add it back, but it leaves every total, report and promotion figure (the same as a bonus cleared and given again).
 */
export async function toggleClaimCounted(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("promotions", 3);
    const c = await prisma.promoClaim.findUniqueOrThrow({ where: { id: int(fd, "id") }, include: { promotion: true, player: { select: { username: true } } } });
    assertBrand(user, c.promotion.brandId);
    need(!c.replacedById, "This bonus was cleared and given again: the one given again is counted instead.");
    const off = !c.voidedAt;
    if (off) await safely("unlink", () => unlinkClaims({ id: c.id }));
    await prisma.promoClaim.update({ where: { id: c.id }, data: { voidedAt: off ? new Date() : null } });
    if (!off) await safely("link", () => linkClaims({ id: c.id }));
    await safely("box", () => trackBoxes([c.playerId]));
    await audit(
      user,
      "UPDATE",
      "PromoClaim",
      c.id,
      c.promotion.brandId,
      `${off ? "Stopped counting" : "Counted again"} ${c.promotion.name} of ${c.amount} for ${c.player.username}${c.ref ? ` (${c.ref})` : ""}`,
    );
    revalidatePath("/promotions", "layout");
    revalidatePath(`/players/${c.playerId}`);
    revalidatePath("/");
    return off ? "Marked as not counted." : "Counted again.";
  });
}
