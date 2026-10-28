// First-time setup: default roles, the administrator account and starter expense categories.
// Safe to run again — it only adds what's missing.
//
//   npm run db:seed
//   npm run db:seed -- --reset-roles   (also puts the built-in roles back to their default permissions)
//
// The administrator signs in with username "admin". The first password comes from ADMIN_PASSWORD
// in .env; without it a random one is generated and printed once. Change it under "My account".

import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_ROLES } from "../lib/perms";

const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || randomBytes(9).toString("base64url");

const prisma = new PrismaClient();

function hash(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(pw, salt, 64).toString("base64")}`;
}

async function main() {
  for (const r of DEFAULT_ROLES) {
    await prisma.role.upsert({
      where: { name: r.name },
      create: { name: r.name, perms: r.perms, locked: !!r.locked },
      update: r.locked || process.argv.includes("--reset-roles") ? { perms: r.perms, locked: !!r.locked } : {},
    });
  }
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: "Administrator" } });
  const admin = await prisma.user.findUnique({ where: { username: "admin" } });
  if (!admin) {
    await prisma.user.create({
      data: { username: "admin", name: "Administrator", passwordHash: hash(INITIAL_ADMIN_PASSWORD), roleId: adminRole.id, allBrands: true },
    });
    console.log(process.env.ADMIN_PASSWORD ? 'Created user "admin" with ADMIN_PASSWORD from .env.' : `Created user "admin" with password: ${INITIAL_ADMIN_PASSWORD}  (shown once — write it down)`);
  }

  const categories: [string, "EXPENSE" | "INCOME"][] = [
    ["Salary", "EXPENSE"],
    ["Advertising", "EXPENSE"],
    ["Rental", "EXPENSE"],
    ["Software & tools", "EXPENSE"],
    ["Other expenses", "EXPENSE"],
    ["Provider rebate", "INCOME"],
    ["Other income", "INCOME"],
  ];
  for (const [i, [name, kind]] of categories.entries()) {
    await prisma.expenseCategory.upsert({ where: { name }, create: { name, kind, sort: i }, update: {} });
  }
  console.log("Seed done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
