// Account kinds, shared by server and browser code. No server imports.

import { tk } from "@/lib/i18n";

export const TYPE_LABEL: Record<string, string> = {
  BANK: tk("Bank"),
  PG_OFFLINE: tk("Offline PG"),
  PG: tk("Online PG"),
};

/** Online or offline payment gateway. Banks charge no deposit, withdrawal or settlement fee. */
export const isPg = (type: string) => type === "PG" || type === "PG_OFFLINE";

export function channelType(v: string): "BANK" | "PG" | "PG_OFFLINE" {
  if (v === "PG") return "PG";
  if (v === "PG_OFFLINE") return "PG_OFFLINE";
  return "BANK";
}
