import "server-only";

import { cache } from "react";
import { prisma } from "@/lib/db";

import type { TierRule } from "@/lib/tiers";
export type { TierRule } from "@/lib/tiers";

export type Settings = {
  systemName: string;
  baseCurrency: string;
  /** Which items come off W/L to give net profit. */
  profit: { fees: boolean; promos: boolean; expenses: boolean; income: boolean };
  tierScoring: {
    /** A player reaching these values gets full marks for that part of the score. */
    amountFull: number;
    countFull: number;
    avgFull: number;
    weightAmount: number;
    weightCount: number;
    weightAvg: number;
    tiers: TierRule[];
    lowestName: string;
  };
  churnDays: number[];
  /** A contacted player who deposits within this many days counts as returned. */
  recallDays: number;
  csChannels: string[];
  /** Claimers' deposits are counted from the claim until this many days after. */
  promoWindowDays: number;
  /** Promotions costing more than this % of claimers' deposits are marked "Adjust". */
  promoAdjustPercent: number;
  /** Reconciliation differences at or below this amount count as matched. */
  reconTolerance: number;
};

export const DEFAULT_SETTINGS: Settings = {
  systemName: "Business Analytics",
  baseCurrency: "MYR",
  profit: { fees: true, promos: true, expenses: true, income: true },
  tierScoring: {
    amountFull: 20000,
    countFull: 30,
    avgFull: 500,
    weightAmount: 50,
    weightCount: 30,
    weightAvg: 20,
    tiers: [
      { name: "High value", minScore: 60 },
      { name: "Regular", minScore: 25 },
    ],
    lowestName: "Low activity",
  },
  churnDays: [7, 15, 30],
  recallDays: 7,
  csChannels: ["WhatsApp", "Telegram", "SMS", "Phone call"],
  promoWindowDays: 7,
  promoAdjustPercent: 10,
  reconTolerance: 1,
};

export const getSettings = cache(async (): Promise<Settings> => {
  const rows = await prisma.setting.findMany();
  const s = structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>;
  for (const r of rows) {
    if (!(r.key in s)) continue;
    const def = s[r.key];
    s[r.key] = def && typeof def === "object" && !Array.isArray(def) ? { ...def, ...(r.value as object) } : r.value;
  }
  return s as Settings;
});

export async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as object },
    update: { value: value as object },
  });
}

export { scorePlayer, type Tier } from "@/lib/tiers";
