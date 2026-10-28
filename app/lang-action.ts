"use server";

import { cookies } from "next/headers";
import { getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isLang } from "@/lib/i18n";
import { LANG_COOKIE } from "@/lib/i18n-server";

/** Saves the language on this device and, when signed in, on the account so other devices follow. */
export async function setLang(lang: string) {
  if (!isLang(lang)) return;
  (await cookies()).set(LANG_COOKIE, lang, { path: "/", sameSite: "lax", maxAge: 365 * 86400 });
  const user = await getUser();
  if (user) await prisma.user.update({ where: { id: user.id }, data: { lang } });
}
