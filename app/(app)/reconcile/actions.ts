"use server";

import { revalidatePath } from "next/cache";
import { assertBrand, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, str, type Result } from "@/lib/action";
import { dateOnly } from "@/lib/dates";
import { prisma } from "@/lib/db";

export async function saveReconNote(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 3);
    const brandId = int(fd, "brandId");
    const day = str(fd, "date");
    assertBrand(user, brandId);
    need(/^\d{4}-\d{2}-\d{2}$/.test(day), "Invalid date.");
    const note = str(fd, "note").slice(0, 500);
    const resolved = fd.get("resolved") === "on";
    const where = { brandId_date: { brandId, date: dateOnly(day) } };
    if (!note && !resolved) {
      await prisma.reconNote.deleteMany({ where: { brandId, date: dateOnly(day) } });
    } else {
      await prisma.reconNote.upsert({ where, create: { brandId, date: dateOnly(day), note, resolved, userName: user.name }, update: { note, resolved, userName: user.name } });
    }
    await audit(user, "UPDATE", "ReconNote", `${brandId}:${day}`, brandId, `${resolved ? "Marked checked" : "Noted"} reconciliation for ${day}`, { note });
    revalidatePath("/reconcile");
    return "Saved.";
  });
}
