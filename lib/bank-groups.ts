import { prisma } from "@/lib/db";

/**
 * Offline bank accounts belong to an agent (X Group, Mimi Pay…). Each agent is one account for all brands,
 * named after the agent. A platform bank joins an agent when its remark — the "(…)" part of the name — starts with one of the agent's codes.
 */
export type BankGroup = { name: string; codes: string[] };

export const DEFAULT_BANK_GROUPS: BankGroup[] = [
  { name: "X GROUP", codes: ["X GROUP", "XGP", "X04"] },
  { name: "MIMI PAY", codes: ["MIMI", "MIMP", "MMP", "MM"] },
  { name: "PAY BOX", codes: ["PAYBOX", "PB", "PC"] },
  { name: "GM PAY", codes: ["GMP", "GM", "MBK", "MBT"] },
];

const norm = (s: string) => s.toUpperCase().replace(/[（）()]/g, " ").replace(/\s+/g, " ").trim();

/** The agent a platform bank label such as "PAYNOWUEN (PB PC53)" belongs to, or null. */
export function groupFor(label: string, groups: BankGroup[]) {
  const a = label.indexOf("(");
  const b = label.lastIndexOf(")");
  if (a < 0 || b <= a) return null;
  const remark = norm(label.slice(a + 1, b));
  for (const g of groups) if (g.codes.some((c) => c.trim() && remark.startsWith(norm(c)))) return g.name.trim().slice(0, 80);
  return null;
}

/** Parse the settings text: one agent per line, "NAME = CODE, CODE". */
export function parseBankGroups(text: string): BankGroup[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split("="))
    .filter((p) => p.length === 2 && p[0].trim())
    .map(([name, codes]) => ({ name: name.trim(), codes: codes.split(",").map((c) => c.trim()).filter(Boolean) }))
    .filter((g) => g.codes.length);
}

export const bankGroupsText = (groups: BankGroup[]) => groups.map((g) => `${g.name} = ${g.codes.join(", ")}`).join("\n");

/**
 * Move every bank account whose remark matches an agent into that agent's account: its transactions, movements and balance checks
 * go over, the platform links point the bank there for future syncs, and the old account is removed.
 * Transactions keep the platform's bank in `source`, so where each came from is not lost.
 */
export async function applyBankGroups(groups: BankGroup[]) {
  const names = new Set(groups.map((g) => g.name.trim()));
  const banks = await prisma.payChannel.findMany({ where: { type: "BANK" } });
  const plan = new Map<string, number[]>();
  for (const c of banks) {
    if (names.has(c.name)) continue;
    const label = c.name.includes(" · ") ? c.name.slice(c.name.indexOf(" · ") + 3) : c.name;
    const g = groupFor(label, groups);
    if (g) plan.set(g, [...(plan.get(g) ?? []), c.id]);
  }
  const moved: Record<string, { accounts: number; txns: number }> = {};
  const target = new Map<number, number>();
  for (const [name, ids] of plan) {
    const currency = banks.find((b) => b.id === ids[0])!.currency;
    const t = await prisma.payChannel.upsert({ where: { name }, create: { name, type: "BANK", currency }, update: { active: true, deactivatedAt: null } });
    const [txns] = await prisma.$transaction([
      prisma.txn.updateMany({ where: { channelId: { in: ids } }, data: { channelId: t.id } }),
      prisma.channelMove.updateMany({ where: { channelId: { in: ids } }, data: { channelId: t.id } }),
      prisma.balanceCheck.updateMany({ where: { channelId: { in: ids } }, data: { channelId: t.id } }),
      prisma.statementDay.deleteMany({ where: { channelId: { in: ids } } }),
      prisma.payChannel.deleteMany({ where: { id: { in: ids } } }),
    ]);
    for (const id of ids) target.set(id, t.id);
    moved[name] = { accounts: ids.length, txns: txns.count };
  }
  if (target.size) {
    for (const l of await prisma.platformLink.findMany({ select: { id: true, channelMap: true } })) {
      const map = (l.channelMap ?? {}) as Record<string, { id: number; label: string }>;
      let changed = false;
      for (const v of Object.values(map))
        if (target.has(v.id)) {
          v.id = target.get(v.id)!;
          changed = true;
        }
      if (changed) await prisma.platformLink.update({ where: { id: l.id }, data: { channelMap: map } });
    }
  }
  return moved;
}
