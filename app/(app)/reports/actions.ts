"use server";

import { revalidatePath } from "next/cache";
import { can, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";

export async function saveReport(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reports", 1);
    const name = str(fd, "name");
    need(name, "Give the report a name.");
    const shared = fd.get("shared") === "on" && can(user, "reports", 3);
    const config = { group: str(fd, "group"), cols: str(fd, "cols"), preset: str(fd, "preset") || null, from: str(fd, "from") || null, to: str(fd, "to") || null };
    const r = await prisma.savedReport.create({ data: { name, config, ownerId: user.id, shared } });
    await audit(user, "CREATE", "SavedReport", r.id, null, `Saved report "${name}"${shared ? " for the team" : ""}`);
    revalidatePath("/reports");
    return "Report saved.";
  });
}

export async function deleteReport(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reports", 1);
    const r = await prisma.savedReport.findUniqueOrThrow({ where: { id: int(fd, "id") } });
    need(r.ownerId === user.id || can(user, "reports", 3), "You can only delete your own reports.");
    await prisma.savedReport.delete({ where: { id: r.id } });
    await audit(user, "DELETE", "SavedReport", r.id, null, `Deleted report "${r.name}"`);
    revalidatePath("/reports");
  });
}
