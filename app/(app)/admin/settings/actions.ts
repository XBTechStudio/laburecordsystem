"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { amount, int, need, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";
import { getSettings, saveSetting, type Settings } from "@/lib/settings";

const num = (fd: FormData, k: string) => amount(str(fd, k));

async function save<K extends keyof Settings>(key: K, value: Settings[K], label: string) {
  const user = await guard("settings", 3);
  const before = (await getSettings())[key];
  await saveSetting(key, value);
  await audit(user, "UPDATE", "Setting", key, null, `Changed ${label}`, { before, after: value });
  revalidatePath("/", "layout");
}

export async function saveGeneral(_p: Result, fd: FormData) {
  return run(async () => {
    const name = str(fd, "systemName");
    const cur = str(fd, "baseCurrency").toUpperCase();
    need(name, "Please enter a system name.");
    need(/^[A-Z]{3}$/.test(cur), "Base currency should be a 3-letter code like MYR.");
    await save("systemName", name, "system name");
    await save("baseCurrency", cur, "base currency");
    await save(
      "profit",
      { fees: fd.get("fees") === "on", promos: fd.get("promos") === "on", expenses: fd.get("expenses") === "on", income: fd.get("income") === "on" },
      "net profit formula",
    );
  });
}

export async function saveTiers(_p: Result, fd: FormData) {
  return run(async () => {
    const names = fd.getAll("tierName").map((v) => String(v).trim());
    const mins = fd.getAll("tierMin").map((v) => Number(v));
    const tiers = names.map((name, i) => ({ name, minScore: mins[i] })).filter((t) => t.name && Number.isFinite(t.minScore));
    const v: Settings["tierScoring"] = {
      amountFull: num(fd, "amountFull"),
      countFull: num(fd, "countFull"),
      avgFull: num(fd, "avgFull"),
      weightAmount: num(fd, "weightAmount"),
      weightCount: num(fd, "weightCount"),
      weightAvg: num(fd, "weightAvg"),
      tiers: tiers.sort((a, b) => b.minScore - a.minScore),
      lowestName: str(fd, "lowestName") || "Low activity",
    };
    need([v.amountFull, v.countFull, v.avgFull].every((x) => x > 0), "Full-mark values must be more than 0.");
    need([v.weightAmount, v.weightCount, v.weightAvg].every((x) => x >= 0) && v.weightAmount + v.weightCount + v.weightAvg > 0, "Weights can't be negative and can't all be 0.");
    need(tiers.every((t) => t.minScore >= 0 && t.minScore <= 100), "Minimum scores must be between 0 and 100.");
    await save("tierScoring", v, "player tier rules");
    return "Tier rules saved. Every player list uses them from now on.";
  });
}

export async function saveFollowUp(_p: Result, fd: FormData) {
  return run(async () => {
    const days = str(fd, "churnDays")
      .split(/[,\s]+/)
      .map(Number)
      .filter((x) => Number.isInteger(x) && x > 0);
    const channels = str(fd, "csChannels")
      .split(/\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    const recall = int(fd, "recallDays");
    need(days.length, "Enter at least one churn threshold, e.g. 7, 15, 30.");
    need(recall > 0, "Return window must be at least 1 day.");
    need(channels.length, "Enter at least one contact channel.");
    await save("churnDays", [...new Set(days)].sort((a, b) => a - b), "churn thresholds");
    await save("recallDays", recall, "return window");
    await save("csChannels", channels, "CS channels");
  });
}

export async function saveRules(_p: Result, fd: FormData) {
  return run(async () => {
    const win = int(fd, "promoWindowDays");
    const adj = num(fd, "promoAdjustPercent");
    const tol = num(fd, "reconTolerance");
    need(win >= 0, "Promotion window can't be negative.");
    need(adj >= 0, "Cost threshold can't be negative.");
    need(tol >= 0, "Tolerance can't be negative.");
    await save("promoWindowDays", win, "promotion effect window");
    await save("promoAdjustPercent", adj, "promotion cost threshold");
    await save("reconTolerance", tol, "reconciliation tolerance");
  });
}

export async function saveChannel(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("settings", 3);
    const id = Number(str(fd, "id")) || null;
    const data = {
      name: str(fd, "name"),
      type: str(fd, "type") === "BANK" ? ("BANK" as const) : ("PG" as const),
      feePercent: num(fd, "feePercent") || 0,
      feeFixed: num(fd, "feeFixed") || 0,
    };
    need(data.name, "Please enter the channel name.");
    need(data.feePercent >= 0 && data.feeFixed >= 0, "Fees can't be negative.");
    if (id) {
      await prisma.payChannel.update({ where: { id }, data });
      await audit(user, "UPDATE", "PayChannel", id, null, `Edited channel ${data.name}`, data);
    } else {
      const c = await prisma.payChannel.create({ data });
      await audit(user, "CREATE", "PayChannel", c.id, null, `Added channel ${data.name}`, data);
    }
    revalidatePath("/admin/settings");
    return "Channel saved.";
  });
}

export async function toggleChannel(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("settings", 3);
    const id = int(fd, "id");
    const c = await prisma.payChannel.findUniqueOrThrow({ where: { id } });
    await prisma.payChannel.update({ where: { id }, data: { active: !c.active } });
    await audit(user, "UPDATE", "PayChannel", id, null, `${c.active ? "Deactivated" : "Reactivated"} channel ${c.name}`);
    revalidatePath("/admin/settings");
  });
}
