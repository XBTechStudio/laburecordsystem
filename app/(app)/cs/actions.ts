"use server";

import { revalidatePath } from "next/cache";
import { assertBrand, can, Denied, getUser, guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { amount, int, need, run, str, type Result } from "@/lib/action";
import { fromLocalInput } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { getT } from "@/lib/i18n-server";

/** CS can log from the churn list or the CS page, so either permission is enough. */
async function csUser(min: 2 | 3) {
  const u = await getUser();
  if (!u) throw new Denied("Your session has ended. Please log in again.");
  if (!can(u, "cs", min) && !can(u, "churn", min)) throw new Denied("You don't have permission to do this.");
  return u;
}

function revalidate() {
  revalidatePath("/churn");
  revalidatePath("/cs");
  revalidatePath("/players", "layout");
}

export async function logContact(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await csUser(2);
    let playerId = int(fd, "playerId");
    if (!Number.isInteger(playerId)) {
      // Logged from the CS page by username.
      const brandId = int(fd, "brandId");
      const username = str(fd, "username");
      need(Number.isInteger(brandId), "Choose the brand.");
      need(username, "Enter the player's username.");
      const p = await prisma.player.findUnique({ where: { brandId_username: { brandId, username } } });
      need(p, (await getT())("No player “{name}” in this brand.", { name: username }));
      playerId = p.id;
    }
    const player = await prisma.player.findUniqueOrThrow({ where: { id: playerId } });
    assertBrand(user, player.brandId);
    const channel = str(fd, "channel");
    need(channel, "Choose how you contacted the player.");
    const time = str(fd, "time");
    const bonus = amount(str(fd, "bonus") || "0");
    need(bonus >= 0, "Bonus can't be negative.");
    const promotionId = Number(str(fd, "promotionId")) || null;

    const settings = await getSettings();
    const recent = await prisma.contactLog.findFirst({
      where: { playerId, staffId: { not: user.id }, contactedAt: { gte: new Date(Date.now() - settings.recallDays * 86400_000) } },
      include: { staff: true },
      orderBy: { contactedAt: "desc" },
    });
    if (recent && fd.get("confirmDup") !== "on") {
      need(false, (await getT())("{name} already contacted this player on {date}. Tick “Contact anyway” if you still want to log this.", { name: recent.staff.name, date: recent.contactedAt.toISOString().slice(0, 10) }));
    }

    const c = await prisma.contactLog.create({
      data: {
        playerId,
        staffId: user.id,
        channel,
        promotionId,
        bonus,
        contactedAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time) ? fromLocalInput(time) : new Date(),
        replied: fd.get("replied") === "on",
        result: str(fd, "result").slice(0, 250) || null,
      },
    });
    // Whoever follows up a player who has no owner becomes their CS.
    if (!player.assignedToId) await prisma.player.update({ where: { id: playerId }, data: { assignedToId: user.id } });
    await audit(user, "CREATE", "ContactLog", c.id, player.brandId, `Contacted ${player.username} via ${channel}`);
    revalidate();
    return "Contact logged.";
  });
}

export async function deleteContact(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("cs", 2);
    const id = int(fd, "id");
    const c = await prisma.contactLog.findUniqueOrThrow({ where: { id }, include: { player: true } });
    assertBrand(user, c.player.brandId);
    need(can(user, "cs", 3) || (c.staffId === user.id && Date.now() - c.createdAt.getTime() < 3600_000), "Only a supervisor can delete this.");
    await prisma.contactLog.delete({ where: { id } });
    await audit(user, "DELETE", "ContactLog", id, c.player.brandId, `Deleted contact with ${c.player.username}`, c);
    revalidate();
    return "Deleted.";
  });
}

export async function assignPlayer(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await csUser(2);
    const playerId = int(fd, "playerId");
    const to = str(fd, "staffId");
    const staffId = to === "me" ? user.id : Number(to) || null;
    const p = await prisma.player.findUniqueOrThrow({ where: { id: playerId } });
    assertBrand(user, p.brandId);
    const full = can(user, "churn", 3) || can(user, "players", 3);
    // Staff without full access can only take unassigned players for themselves.
    need(full || (staffId === user.id && (!p.assignedToId || p.assignedToId === user.id)), "Only a supervisor can reassign players.");
    await prisma.player.update({ where: { id: playerId }, data: { assignedToId: staffId } });
    await audit(user, "UPDATE", "Player", playerId, p.brandId, `Assigned ${p.username} to ${staffId ? (staffId === user.id ? user.name : `staff #${staffId}`) : "nobody"}`);
    revalidate();
    return staffId === user.id ? "Assigned to you." : "Assigned.";
  });
}
