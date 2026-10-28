"use server";

import { revalidatePath } from "next/cache";
import { assertBrand, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";
import { phoneKey } from "@/lib/format";

export async function updatePlayer(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("players", 3);
    const id = int(fd, "id");
    const p = await prisma.player.findUniqueOrThrow({ where: { id } });
    assertBrand(user, p.brandId);
    const phone = str(fd, "phone") || null;
    const data = { phone, phoneKey: phoneKey(phone), name: str(fd, "name") || null, note: str(fd, "note").slice(0, 250) || null };
    await prisma.player.update({ where: { id }, data });
    await audit(user, "UPDATE", "Player", id, p.brandId, `Edited player ${p.username}`, { before: { phone: p.phone, name: p.name, note: p.note }, after: data });
    revalidatePath(`/players/${id}`);
    return "Saved.";
  });
}
