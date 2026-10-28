import type { Dict } from "@/lib/i18n";
import { STRINGS } from "@/lib/i18n/strings";

export const id: Dict = Object.fromEntries(STRINGS.map((s) => [s[0], s[2]]));
