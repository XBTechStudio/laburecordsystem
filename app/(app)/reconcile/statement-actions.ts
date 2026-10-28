"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, str, type Result } from "@/lib/action";
import { dateOnly } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { getT } from "@/lib/i18n-server";
import { syncStatements } from "@/lib/statements";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "Read now": fetch the day's statement pages straight away instead of waiting for the next automatic read. */
export async function readStatementsNow(_p: Result, fd: FormData) {
  return run(async () => {
    await guard("reconcile", 2);
    const day = str(fd, "day");
    need(DAY.test(day), "Pick a day.");
    const id = Number(str(fd, "channelId")) || null;
    const r = await syncStatements(day, id ? [id] : undefined);
    revalidatePath("/reconcile/statements", "layout");
    const t = await getT();
    if (r.read + r.empty + r.failed === 0) return { message: t("No account has a statement link yet."), warn: true };
    const parts = [t("Read: {n}", { n: r.read })];
    if (r.empty) parts.push(t("no statement for this day: {n}", { n: r.empty }));
    if (r.failed) parts.push(t("could not be read: {n}", { n: r.failed }));
    return { message: parts.join(" · "), warn: r.failed > 0 };
  });
}

/** Someone looked at the day's differences and is happy with them (or explains them in the note). */
export async function markStatementChecked(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("reconcile", 2);
    const day = str(fd, "day");
    const channelId = int(fd, "channelId");
    need(DAY.test(day), "Pick a day.");
    const undo = str(fd, "undo") === "1";
    const note = str(fd, "note").slice(0, 250) || null;
    const d = await prisma.statementDay.findUniqueOrThrow({ where: { channelId_day: { channelId, day: dateOnly(day) } }, include: { channel: true } });
    await prisma.statementDay.update({
      where: { id: d.id },
      data: undo ? { checkedBy: null, checkedAt: null } : { checkedBy: user.name, checkedAt: new Date(), note },
    });
    await audit(user, "UPDATE", "StatementDay", d.id, null, `${undo ? "Reopened" : "Checked"} ${d.channel.name} statement for ${day}${note ? `: ${note}` : ""}`);
    revalidatePath("/reconcile/statements", "layout");
    revalidatePath("/");
    if (undo) return "Opened again.";
    return "Marked as checked.";
  });
}
