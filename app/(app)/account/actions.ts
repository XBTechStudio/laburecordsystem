"use server";

import { revalidatePath } from "next/cache";
import { hashPassword, requireUser, verifyPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { need, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";

export async function changePassword(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await requireUser();
    const next = str(fd, "next");
    need(next.length >= 8, "The new password needs at least 8 characters.");
    need(next === str(fd, "repeat"), "The two new passwords don't match.");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    need(await verifyPassword(str(fd, "current"), row.passwordHash), "Your current password is not correct.");
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } });
    await prisma.session.deleteMany({ where: { userId: user.id, id: { not: user.sessionId } } });
    await audit(user, "UPDATE", "User", user.id, null, "Changed own password");
    revalidatePath("/account");
    return "Password changed. Other devices have been signed out.";
  });
}

export async function endSession(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await requireUser();
    await prisma.session.deleteMany({ where: { id: str(fd, "id"), userId: user.id } });
    revalidatePath("/account");
  });
}
