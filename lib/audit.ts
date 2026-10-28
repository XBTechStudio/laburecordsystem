import "server-only";

import { prisma } from "@/lib/db";

type Who = { id: number; name: string } | null;

export async function audit(
  user: Who,
  action: "CREATE" | "UPDATE" | "DELETE" | "IMPORT" | "UNDO" | "LOGIN" | "SETTLE" | "PAY",
  entity: string,
  entityId?: number | string | null,
  brandId?: number | null,
  summary?: string,
  detail?: unknown,
) {
  await prisma.auditLog.create({
    data: {
      userId: user?.id ?? null,
      userName: user?.name ?? null,
      action,
      entity,
      entityId: entityId == null ? null : String(entityId),
      brandId: brandId ?? null,
      summary: summary?.slice(0, 250) ?? null,
      detail: detail === undefined ? undefined : JSON.parse(JSON.stringify(detail)),
    },
  });
}
