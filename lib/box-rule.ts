// Lucky Box release rules of a promotion. Shared by the settings dialog (browser) and the box engine (server).

import type { T } from "@/lib/i18n";
import { sym } from "@/lib/format";

export type BoxRule = {
  /** A withdrawal whose net win (the withdrawal − deposits since the previous withdrawal) reaches this releases the box. 0 = not needed. */
  minNetWin: number;
  /** Deposits since the box filled up (or since the last release) must reach this. 0 = not needed. */
  minDeposit: number;
  /** Most that comes out per release; 0 = everything in the box at once. */
  releaseCap: number;
  /** Points not released after this many days run out. 0 = never. */
  expiryDays: number;
  /** Tell CS when a box can be released. */
  notify: boolean;
};

export const DEFAULT_BOX: BoxRule = { minNetWin: 0, minDeposit: 0, releaseCap: 0, expiryDays: 0, notify: true };

const num = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : 0;
};

/** Reads a stored rule, filling anything missing with defaults; null = not a Lucky Box promotion. */
export function readBox(raw: unknown): BoxRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<BoxRule>;
  return { minNetWin: num(r.minNetWin), minDeposit: num(r.minDeposit), releaseCap: num(r.releaseCap), expiryDays: Math.round(num(r.expiryDays)), notify: r.notify !== false };
}

/** Does this rule release by itself (the system can tell when), or only by hand? */
export const autoRelease = (r: BoxRule) => r.minNetWin > 0 || r.minDeposit > 0;

/** One line, e.g. "Withdrawal with net win of S$ 50+ · up to S$ 50 each time". */
export function boxText(r: BoxRule, t: T, cur = "") {
  const c = cur ? sym(cur) + " " : "";
  const parts: string[] = [];
  if (r.minNetWin > 0) parts.push(t("withdrawal with a net win of {amount}+", { amount: c + r.minNetWin.toLocaleString("en") }));
  if (r.minDeposit > 0) parts.push(t("deposits of {amount}+ since the box filled", { amount: c + r.minDeposit.toLocaleString("en") }));
  const when = parts.length ? parts.join(" + ") : t("released by hand");
  const how = r.releaseCap > 0 ? t("up to {amount} each time", { amount: c + r.releaseCap.toLocaleString("en") }) : t("everything at once");
  return `${when} · ${how}${r.expiryDays > 0 ? " · " + t("expires after {n} days", { n: r.expiryDays }) : ""}`;
}
