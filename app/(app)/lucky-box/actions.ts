"use server";

import { revalidatePath } from "next/cache";
import { assertBrand, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { amount, int, need, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";
import { boxPromos, boxStates, releaseBox } from "@/lib/lucky-box";

/** Records points given back to the player on the platform. */
export async function releaseFromBox(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("luckybox", 2);
    const playerId = int(fd, "playerId");
    const promotionId = int(fd, "promotionId");
    const player = await prisma.player.findUniqueOrThrow({ where: { id: playerId } });
    assertBrand(user, player.brandId);
    const promos = (await boxPromos([player.brandId], false)).filter((p) => p.id === promotionId);
    need(promos.length, "This isn't a Lucky Box promotion.");
    const st = (await boxStates({ playerIds: [playerId], promos }))[0];
    const amt = Math.round(amount(str(fd, "amount")) * 100) / 100;
    need(st && st.balance > 0.005, "This Lucky Box is already empty.");
    need(amt > 0, "Amount must be more than 0.");
    need(amt <= st.balance + 0.005, "That's more than what's in the box.");
    await releaseBox({ playerId, promotionId, amount: amt, userId: user.id, note: str(fd, "note").slice(0, 250) || null });
    await audit(user, "CREATE", "BoxEntry", null, player.brandId, `Released ${amt} from the Lucky Box (${promos[0].name}) for ${player.username}`);
    revalidatePath("/lucky-box");
    revalidatePath("/alerts");
    return "Release recorded.";
  });
}
