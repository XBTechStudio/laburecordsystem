import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { isLang, makeT, type Dict, type Lang } from "@/lib/i18n";
import { id } from "@/lib/i18n/id";
import { zh } from "@/lib/i18n/zh";

export const LANG_COOKIE = "xb_lang";

export const getLang = cache(async (): Promise<Lang> => {
  const v = (await cookies()).get(LANG_COOKIE)?.value;
  return isLang(v) ? v : "en";
});

export function dictFor(lang: Lang): Dict | null {
  return lang === "zh" ? zh : lang === "id" ? id : null;
}

export const getT = cache(async () => makeT(dictFor(await getLang())));
