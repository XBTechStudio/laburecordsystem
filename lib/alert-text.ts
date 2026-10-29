// How an alert reads, in the reader's language. Shared by the alerts page and the pop-ups.

import { tk, type T } from "@/lib/i18n";
import { sym } from "@/lib/format";
import { progressText, type PromoRule, type PromoTier } from "@/lib/promo-rule";

export type AlertKindName = "NEAR" | "ELIGIBLE" | "EXPIRING" | "RECALLED" | "REFOLLOW" | "BOX";

export const KIND_LABEL: Record<AlertKindName, string> = {
  NEAR: tk("Close to a bonus"),
  ELIGIBLE: tk("Bonus ready"),
  EXPIRING: tk("Bonus expiring"),
  RECALLED: tk("Recalled"),
  REFOLLOW: tk("Follow up again"),
  BOX: tk("Lucky Box ready"),
};

export const KIND_TONE: Record<AlertKindName, "brand" | "good" | "warning" | "critical" | "neutral"> = {
  NEAR: "brand",
  ELIGIBLE: "good",
  EXPIRING: "warning",
  RECALLED: "good",
  REFOLLOW: "neutral",
  BOX: "warning",
};

type Data = {
  promo?: string;
  tier?: number;
  tiers?: number;
  amount?: number;
  count?: number;
  target?: { amount: number; count: number };
  basis?: PromoRule["basis"];
  bonus?: number;
  payNext?: boolean;
  expiresAt?: string | null;
  deposit?: number;
  depositAt?: string;
  contactAt?: string;
  channel?: string;
  balance?: number;
  netWin?: number;
};

const fmt = (v: number | undefined) => (Math.round((v ?? 0) * 100) / 100).toLocaleString("en");

/** Malaysia/Singapore time, e.g. "10-29 21:30". */
export function when(iso: string | Date | null | undefined) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
}

/** Main line (what to tell the player) and a detail line. */
export function alertText(kind: AlertKindName, raw: unknown, t: T, cur = ""): { title: string; detail: string } {
  const d = (raw ?? {}) as Data;
  const c = cur ? sym(cur) + " " : "";
  const tierNo = d.tiers && d.tiers > 1 ? " · " + t("tier {a}/{b}", { a: (d.tier ?? 0) + 1, b: d.tiers }) : "";
  switch (kind) {
    case "NEAR": {
      const tier: PromoTier = { amount: d.target?.amount ?? 0, count: d.target?.count ?? 0, bonus: 0, pct: 0, cap: 0 };
      const progress = progressText({ basis: d.basis ?? "amount" } as PromoRule, tier, d.amount ?? 0, d.count ?? 0, t, cur);
      return {
        title: `${d.promo}${tierNo}`,
        detail: `${progress} → ${d.payNext ? t("bonus {bonus} next period", { bonus: c + fmt(d.bonus) }) : t("bonus {bonus}", { bonus: c + fmt(d.bonus) })}`,
      };
    }
    case "ELIGIBLE":
      return {
        title: `${d.promo}${tierNo}`,
        detail: t("Qualified: bonus {bonus}", { bonus: c + fmt(d.bonus) }) + (d.expiresAt ? " · " + t("claim by {when}", { when: when(d.expiresAt) }) : ""),
      };
    case "EXPIRING":
      return {
        title: `${d.promo}${tierNo}`,
        detail: t("Bonus {bonus} not claimed yet, expires {when}", { bonus: c + fmt(d.bonus), when: when(d.expiresAt) }),
      };
    case "RECALLED":
      return {
        title: t("Deposited {amount}", { amount: c + fmt(d.deposit) }),
        detail: t("{when}, after the contact on {contact} ({channel})", { when: when(d.depositAt), contact: when(d.contactAt), channel: t(d.channel ?? "") }),
      };
    case "BOX":
      return {
        title: `${d.promo} · ${t("release {amount}", { amount: c + fmt(d.bonus) })}`,
        detail:
          (d.netWin != null ? t("Withdrawal on {when} with a net win of {amount}", { when: when(d.depositAt), amount: c + fmt(d.netWin) }) : t("Deposited {amount} since the box filled", { amount: c + fmt(d.deposit) })) +
          " · " +
          t("in the box: {amount}", { amount: c + fmt(d.balance) }),
      };
    case "REFOLLOW":
      return {
        title: t("No deposit since the last contact"),
        detail: t("Contacted {when} via {channel}", { when: when(d.contactAt), channel: t(d.channel ?? "") }),
      };
  }
}
