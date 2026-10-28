import "server-only";

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { MODULES, levelOf, type Level, type Module, type Perms } from "@/lib/perms";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "xb_sess";

// ---- passwords ----

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string) {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(pw, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

// ---- login throttling (single process, so memory is enough) ----

const fails = new Map<string, { count: number; until: number }>();

export function loginBlockedFor(key: string) {
  const f = fails.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}

function noteFail(key: string) {
  const f = fails.get(key) ?? { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) {
    f.until = Date.now() + 10 * 60_000;
    f.count = 0;
  }
  fails.set(key, f);
}

// ---- sessions ----

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function signIn(username: string, password: string, remember: boolean) {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  const key = `${ip}|${username.toLowerCase()}`;
  const blocked = loginBlockedFor(key);
  if (blocked) return { error: { text: "Too many attempts. Try again in {n} min.", vars: { n: blocked } } };

  const user = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    noteFail(key);
    return { error: { text: "Wrong username or password.", vars: undefined } };
  }
  if (!user.active) return { error: { text: "This account has been disabled. Please contact your administrator.", vars: undefined } };
  fails.delete(key);

  const token = randomBytes(32).toString("base64url");
  const maxAge = remember ? 30 * 86400 : 12 * 3600;
  await prisma.session.create({
    data: {
      id: sha(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + maxAge * 1000),
      ip,
      userAgent: (h.get("user-agent") ?? "").slice(0, 250),
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(remember ? { maxAge } : {}),
  });
  // Follow the language this person chose before, on any device.
  if (user.lang) store.set("xb_lang", user.lang, { path: "/", sameSite: "lax", maxAge: 365 * 86400 });
  return { user };
}

export async function signOut() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { id: sha(token) } });
  store.delete(SESSION_COOKIE);
}

export type CurrentUser = {
  id: number;
  username: string;
  name: string;
  roleName: string;
  perms: Perms;
  /** null = every brand */
  brandIds: number[] | null;
  sessionId: string;
};

export const getUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await prisma.session.findUnique({
    where: { id: sha(token) },
    include: { user: { include: { role: true, brands: true } } },
  });
  if (!s || s.expiresAt < new Date() || !s.user.active) return null;
  if (Date.now() - s.lastSeenAt.getTime() > 5 * 60_000) {
    await prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
  }
  const u = s.user;
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    roleName: u.role.name,
    perms: (u.role.perms ?? {}) as Perms,
    brandIds: u.allBrands ? null : u.brands.map((b) => b.brandId),
    sessionId: s.id,
  };
});

export function level(user: CurrentUser, m: Module): Level {
  return levelOf(user.perms, m);
}

export function can(user: CurrentUser, m: Module, min: Level = 1) {
  return level(user, m) >= min;
}

/** First page this user may open — where we send people who land somewhere they can't see. */
export function homeFor(user: CurrentUser) {
  const first = MODULES.find((m) => can(user, m.key));
  return first ? first.href : "/account";
}

export async function requireUser() {
  const u = await getUser();
  if (!u) redirect("/login");
  return u;
}

export async function requirePage(m: Module, min: Level = 1) {
  const u = await requireUser();
  if (!can(u, m, min)) redirect(homeFor(u));
  return u;
}

export class Denied extends Error {}

/** For server actions: throws instead of redirecting. */
export async function guard(m: Module, min: Level) {
  const u = await getUser();
  if (!u) throw new Denied("Your session has ended. Please log in again.");
  if (!can(u, m, min)) throw new Denied("You don't have permission to do this.");
  return u;
}

export function canSeeBrand(user: CurrentUser, brandId: number) {
  return !user.brandIds || user.brandIds.includes(brandId);
}

export function assertBrand(user: CurrentUser, brandId: number) {
  if (!canSeeBrand(user, brandId)) throw new Denied("You don't have access to this brand.");
}
