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
  /** Contacted this many days ago and still no deposit → remind CS to follow up again. 0 = off. */
  refollowDays: number;
  /** A deposit after a contact counts as a successful recall only from this amount. */
  recallMinAmount: number;
  /** Saved messages CS can pick when logging a contact. */
  csTemplates: string[];
  /** How promotion tracking counts periods and who gets told. */
  alerts: {
    /** Business day starts at this hour (0 = midnight). */
    dayStartHour: number;
    /** 1 = Monday … 7 = Sunday. */
    weekStartDay: number;
    /** nearest = only the promotion the player is closest to; all = every promotion they are close to. */
    notify: "nearest" | "all";
    /** owner = the player's CS (everyone on the brand when nobody is assigned); team = everyone on the brand. */
    target: "owner" | "team";
    /** Only these roles get alerts; empty = every role that can follow up players. */
    roleIds: number[];
    popup: boolean;
    sound: boolean;
    /** How often open pages check for new alerts. */
    pollSeconds: number;
    /** Alert CS when a contacted player deposits again. */
    recall: boolean;
  };
  /** Claimers' deposits are counted from the claim until this many days after. */
  promoWindowDays: number;
  /** Promotions costing more than this % of claimers' deposits are marked "Adjust". */
  promoAdjustPercent: number;
  /** Reconciliation differences at or below this amount count as matched. */
  reconTolerance: number;
  /** Minutes in which staff may still fix their own entries. 0 = only roles with Full access can change or delete data. */
  selfFixMinutes: number;
  /** A statement line and a recorded transaction with the same amount count as the same when this close in time. */
  statementMinutes: number;
  /** Data entry form. pickTime off = deposits, withdrawals and claims always get the time they are saved. carryBrand = a brand picked on a row fills the empty rows below. */
  entry: { pickTime: boolean; carryBrand: boolean };
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
  refollowDays: 3,
  recallMinAmount: 0,
  csTemplates: [],
  alerts: { dayStartHour: 0, weekStartDay: 1, notify: "nearest", target: "owner", roleIds: [], popup: true, sound: true, pollSeconds: 20, recall: true },
  promoWindowDays: 7,
  promoAdjustPercent: 10,
  reconTolerance: 1,
  selfFixMinutes: 0,
  statementMinutes: 30,
  entry: { pickTime: false, carryBrand: false },
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
