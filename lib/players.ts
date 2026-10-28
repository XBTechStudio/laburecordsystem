import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { phoneKey } from "@/lib/format";

const chunks = <T,>(a: T[], size: number) => Array.from({ length: Math.ceil(a.length / size) }, (_, i) => a.slice(i * size, i * size + size));

/** Recomputes lifetime deposit/withdraw figures for these players from their transactions. */
export async function refreshPlayerStats(playerIds: number[]) {
  const ids = [...new Set(playerIds)].filter(Boolean);
  for (const part of chunks(ids, 1000)) {
    const list = Prisma.join(part);
    await prisma.$executeRaw`
      UPDATE \`Player\` p LEFT JOIN (
        SELECT playerId,
          SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END) AS dt,
          SUM(type = 'DEPOSIT') AS dc,
          SUM(CASE WHEN type = 'WITHDRAW' THEN amount ELSE 0 END) AS wt,
          SUM(type = 'WITHDRAW') AS wc,
          MIN(CASE WHEN type = 'DEPOSIT' THEN txnAt END) AS fd,
          MAX(CASE WHEN type = 'DEPOSIT' THEN txnAt END) AS ld
        FROM \`Txn\` WHERE playerId IN (${list}) GROUP BY playerId
      ) s ON s.playerId = p.id
      SET p.depositTotal = COALESCE(s.dt, 0), p.depositCount = COALESCE(s.dc, 0),
          p.withdrawTotal = COALESCE(s.wt, 0), p.withdrawCount = COALESCE(s.wc, 0),
          p.firstDepositAt = s.fd, p.lastDepositAt = s.ld
      WHERE p.id IN (${list})`;
  }
}

export type PlayerInput = { username: string; phone?: string | null; name?: string | null };

/**
 * Returns username (lower-case) → player id for one brand, creating players that don't exist yet.
 * Existing players get a phone/name filled in if they had none.
 */
export async function ensurePlayers(brandId: number, inputs: PlayerInput[], importId?: number) {
  const wanted = new Map<string, PlayerInput>();
  for (const p of inputs) {
    const u = p.username.trim();
    if (u) wanted.set(u.toLowerCase(), { ...p, username: u });
  }
  const out = new Map<string, number>();
  const created: string[] = [];
  for (const part of chunks([...wanted.keys()], 1000)) {
    const existing = await prisma.player.findMany({
      where: { brandId, username: { in: part } },
      select: { id: true, username: true, phone: true, name: true },
    });
    for (const e of existing) {
      out.set(e.username.toLowerCase(), e.id);
      const w = wanted.get(e.username.toLowerCase());
      if (w && ((!e.phone && w.phone) || (!e.name && w.name))) {
        await prisma.player.update({
          where: { id: e.id },
          data: {
            ...(!e.phone && w.phone ? { phone: w.phone, phoneKey: phoneKey(w.phone) } : {}),
            ...(!e.name && w.name ? { name: w.name } : {}),
          },
        });
      }
    }
    const missing = part.filter((k) => !out.has(k));
    if (missing.length) {
      await prisma.player.createMany({
        data: missing.map((k) => {
          const w = wanted.get(k)!;
          return {
            brandId,
            username: w.username,
            phone: w.phone || null,
            phoneKey: phoneKey(w.phone),
            name: w.name || null,
            importId: importId ?? null,
          };
        }),
        skipDuplicates: true,
      });
      const fresh = await prisma.player.findMany({ where: { brandId, username: { in: missing } }, select: { id: true, username: true } });
      for (const f of fresh) out.set(f.username.toLowerCase(), f.id);
      created.push(...missing);
    }
  }
  return { ids: out, created: created.length };
}
