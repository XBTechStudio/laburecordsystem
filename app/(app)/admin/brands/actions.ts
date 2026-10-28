"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { amount, int, need, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";

function read(fd: FormData) {
  const name = str(fd, "name");
  const currency = (str(fd, "currency") || "MYR").toUpperCase();
  const fxRate = amount(str(fd, "fxRate") || "1");
  need(name, "Please give the brand a name.");
  need(/^[A-Z]{3}$/.test(currency), "Currency should be a 3-letter code like MYR or THB.");
  need(fxRate > 0, "The exchange rate must be more than 0.");
  return { name, currency, fxRate };
}

export async function createBrand(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("brands", 3);
    const data = read(fd);
    const b = await prisma.brand.create({ data });
    await audit(user, "CREATE", "Brand", b.id, b.id, `Added brand ${b.name}`, data);
    revalidatePath("/", "layout");
    return "Brand added.";
  });
}

export async function updateBrand(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("brands", 3);
    const id = int(fd, "id");
    const before = await prisma.brand.findUniqueOrThrow({ where: { id } });
    const data = read(fd);
    await prisma.brand.update({ where: { id }, data });
    await audit(user, "UPDATE", "Brand", id, id, `Edited brand ${data.name}`, { before, after: data });
    revalidatePath("/", "layout");
    return "Brand updated.";
  });
}

export async function toggleBrand(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("brands", 3);
    const id = int(fd, "id");
    const b = await prisma.brand.findUniqueOrThrow({ where: { id } });
    await prisma.brand.update({ where: { id }, data: { active: !b.active } });
    await audit(user, "UPDATE", "Brand", id, id, `${b.active ? "Deactivated" : "Reactivated"} brand ${b.name}`);
    revalidatePath("/", "layout");
  });
}
