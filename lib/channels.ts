import "server-only";
import { prisma } from "@/lib/db";

/**
 * Start again every stopped PG/bank account that has a transaction dated after it was stopped,
 * so an account that comes back into use shows up on reconciliation instead of staying hidden.
 */
export async function reviveChannels() {
  return prisma.$executeRaw`
    UPDATE \`PayChannel\` c SET c.active = 1, c.deactivatedAt = NULL
    WHERE c.active = 0 AND c.deactivatedAt IS NOT NULL
      AND EXISTS (SELECT 1 FROM \`Txn\` t WHERE t.channelId = c.id AND t.txnAt > c.deactivatedAt)`;
}

/** Active accounts with no transaction in the last `days` days (and none at all counts too). */
export async function idleChannels(days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  return prisma.$queryRaw<{ id: number; name: string; last: Date | null }[]>`
    SELECT c.id, c.name, (SELECT MAX(t.txnAt) FROM \`Txn\` t WHERE t.channelId = c.id) AS last
    FROM \`PayChannel\` c
    WHERE c.active = 1 AND NOT EXISTS (SELECT 1 FROM \`Txn\` t WHERE t.channelId = c.id AND t.txnAt >= ${since})
    ORDER BY c.name`;
}

export const IDLE_DAYS = [7, 14, 30, 60, 90] as const;
