import "server-only";

import { Prisma } from "@prisma/client";
import { Denied } from "@/lib/auth";
import { getT } from "@/lib/i18n-server";

export type Result = { ok: boolean; message: string; at: number; data?: unknown } | null;

export class UserError extends Error {}

/** Runs a server action body and turns any failure into a message the form can show. */
export async function run(fn: () => Promise<string | void | { message: string; data?: unknown }>): Promise<Result> {
  const t = await getT();
  try {
    const r = await fn();
    if (r && typeof r === "object") return { ok: true, message: t(r.message), data: r.data, at: Date.now() };
    return { ok: true, message: t(r || "Saved."), at: Date.now() };
  } catch (e) {
    if (e instanceof Denied || e instanceof UserError) return { ok: false, message: t(e.message), at: Date.now() };
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002") return { ok: false, message: t("This already exists. Please use a different name or reference."), at: Date.now() };
      if (e.code === "P2003") return { ok: false, message: t("This is still used by other records, so it can't be removed. Deactivate it instead."), at: Date.now() };
      if (e.code === "P2025") return { ok: false, message: t("This record no longer exists. Refresh the page."), at: Date.now() };
    }
    console.error(e);
    return { ok: false, message: t("Something went wrong. Please try again."), at: Date.now() };
  }
}

export const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
export const opt = (fd: FormData, k: string) => str(fd, k) || null;
export const int = (fd: FormData, k: string) => {
  const v = Number(str(fd, k));
  return Number.isInteger(v) ? v : NaN;
};

/** Accepts "1,234.50", "RM 1234", "(500)". */
export function amount(v: unknown) {
  if (typeof v === "number") return v;
  let s = String(v ?? "").trim();
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[^\d.]/g, "");
  const x = Number(s);
  return s && Number.isFinite(x) ? (neg ? -x : x) : NaN;
}

export function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new UserError(message);
}
