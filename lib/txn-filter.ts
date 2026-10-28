import "server-only";

import type { Prisma } from "@prisma/client";
import { instantRange, parseRange } from "@/lib/dates";

const id = (v: string | undefined) => {
  const x = Number(v);
  return Number.isInteger(x) && x > 0 ? x : undefined;
};

/** Filters for the Transactions page and its Excel export, read from the page's query string. */
export function txnFilter(sp: Record<string, string | undefined>, brandIds: number[]) {
  const range = parseRange(sp, "week");
  const q = sp.q?.trim();
  const where: Prisma.TxnWhereInput = {
    brandId: { in: brandIds },
    txnAt: instantRange(range),
    ...(sp.type === "DEPOSIT" || sp.type === "WITHDRAW" ? { type: sp.type } : {}),
    ...(sp.channel === "none" ? { channelId: null } : id(sp.channel) ? { channelId: id(sp.channel) } : {}),
    ...(id(sp.by) ? { createdById: id(sp.by) } : {}),
    ...(sp.source === "excel" ? { importId: { not: null } } : sp.source === "typed" ? { importId: null } : {}),
    ...(id(sp.player) ? { playerId: id(sp.player) } : {}),
    ...(q ? { OR: [{ player: { username: { contains: q } } }, { ref: { contains: q } }] } : {}),
  };
  return { range, where, playerId: id(sp.player) };
}
