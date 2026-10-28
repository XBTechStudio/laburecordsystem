"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser, signOut } from "@/lib/auth";
import { BRAND_COOKIE } from "@/lib/scope";

export async function setBrand(id: string) {
  await requireUser();
  (await cookies()).set(BRAND_COOKIE, id, { path: "/", sameSite: "lax", maxAge: 365 * 86400 });
}

export async function logout() {
  await signOut();
  redirect("/login");
}
