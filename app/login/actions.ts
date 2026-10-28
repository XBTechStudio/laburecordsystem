"use server";

import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import { audit } from "@/lib/audit";
import type { Result } from "@/lib/action";
import { getT } from "@/lib/i18n-server";

export async function login(_prev: Result, fd: FormData): Promise<Result> {
  const t = await getT();
  const username = String(fd.get("username") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  if (!username || !password) return { ok: false, message: t("Please enter your username and password."), at: Date.now() };
  const r = await signIn(username, password, fd.get("remember") === "on");
  if ("error" in r) return { ok: false, message: t(r.error!.text, r.error!.vars), at: Date.now() };
  await audit({ id: r.user.id, name: r.user.name }, "LOGIN", "User", r.user.id, null, "Signed in");
  redirect("/");
}
