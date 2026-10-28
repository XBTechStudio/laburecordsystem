"use server";

import { revalidatePath } from "next/cache";
import { assertBrand, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";

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
      const brandId = int(fd, "brandId");
      assertBrand(user, brandId);
      const p = await prisma.promotion.create({ data: { brandId, name, note } });
      await audit(user, "CREATE", "Promotion", p.id, brandId, `Added promotion ${name}`);
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
    await audit(user, "UPDATE", "Promotion", p.id, p.brandId, `${p.active ? "Ended" : "Restarted"} promotion ${p.name}`);
    revalidatePath("/promotions");
  });
}
