"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";

export async function saveCategory(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("expenses", 3);
    const id = Number(str(fd, "id")) || null;
    const name = str(fd, "name");
    const kind = str(fd, "kind") === "INCOME" ? ("INCOME" as const) : ("EXPENSE" as const);
    need(name, "Please enter a category name.");
    if (id) {
      await prisma.expenseCategory.update({ where: { id }, data: { name, kind } });
      await audit(user, "UPDATE", "ExpenseCategory", id, null, `Edited category ${name}`);
    } else {
      const max = await prisma.expenseCategory.aggregate({ _max: { sort: true } });
      const c = await prisma.expenseCategory.create({ data: { name, kind, sort: (max._max.sort ?? 0) + 1 } });
      await audit(user, "CREATE", "ExpenseCategory", c.id, null, `Added category ${name}`);
    }
    revalidatePath("/expenses");
    return "Category saved.";
  });
}

export async function toggleCategory(_p: Result, fd: FormData) {
  return run(async () => {
    const user = await guard("expenses", 3);
    const c = await prisma.expenseCategory.findUniqueOrThrow({ where: { id: int(fd, "id") } });
    await prisma.expenseCategory.update({ where: { id: c.id }, data: { active: !c.active } });
    await audit(user, "UPDATE", "ExpenseCategory", c.id, null, `${c.active ? "Hid" : "Restored"} category ${c.name}`);
    revalidatePath("/expenses");
  });
}
