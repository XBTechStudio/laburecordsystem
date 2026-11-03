"use server";

import { revalidatePath } from "next/cache";
import { assertBrand, can, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";
import { phoneKey } from "@/lib/format";
import { statusParam } from "@/lib/player-query";

export async function updatePlayer(_p: Result, fd: FormData) {
  return run(async () => {
    // "View + add" may change the name, remark and status; the phone (used to match brands) needs Full.
    const user = await guard("players", 2);
    const id = int(fd, "id");
    const p = await prisma.player.findUniqueOrThrow({ where: { id } });
    assertBrand(user, p.brandId);
    const status = statusParam(str(fd, "status")) ?? p.status;
    const data = { name: str(fd, "name") || null, note: str(fd, "note").slice(0, 250) || null, status };
    const phone = can(user, "players", 3) ? str(fd, "phone") || null : p.phone;
    await prisma.player.update({ where: { id }, data: { ...data, phone, phoneKey: phoneKey(phone) } });
    await audit(user, "UPDATE", "Player", id, p.brandId, `Edited player ${p.username}`, {
      before: { phone: p.phone, name: p.name, note: p.note, status: p.status },
      after: { ...data, phone },
    });
    revalidatePath(`/players/${id}`);
    revalidatePath("/players");
    return "Saved.";
  });
}
