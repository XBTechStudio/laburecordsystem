"use server";

import { revalidatePath } from "next/cache";
import { guard, hashPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { int, need, run, str, type Result } from "@/lib/action";
import { prisma } from "@/lib/db";
import { MODULES, type Level, type Perms } from "@/lib/perms";

function brandsFrom(fd: FormData) {
  const allBrands = fd.get("allBrands") === "on";
  const ids = fd.getAll("brandIds").map(Number).filter(Number.isInteger);
  return { allBrands, ids };
}

async function adminsLeft(exceptUserId: number) {
  return prisma.user.count({ where: { active: true, role: { locked: true }, id: { not: exceptUserId } } });
}

export async function createUser(_p: Result, fd: FormData) {
  return run(async () => {
    const me = await guard("users", 3);
    const username = str(fd, "username").toLowerCase();
    const name = str(fd, "name");
    const password = str(fd, "password");
    const roleId = int(fd, "roleId");
    need(name, "Please enter the staff member's name.");
    need(/^[a-z0-9._-]{3,40}$/.test(username), "Username: 3–40 characters, letters, numbers, dot, dash or underscore.");
    need(password.length >= 8, "Password needs at least 8 characters.");
    need(Number.isInteger(roleId), "Please choose a role.");
    const { allBrands, ids } = brandsFrom(fd);
    need(allBrands || ids.length, "Tick at least one brand, or give access to all brands.");
    const u = await prisma.user.create({
      data: {
        username,
        name,
        passwordHash: await hashPassword(password),
        roleId,
        allBrands,
        brands: allBrands ? undefined : { create: ids.map((brandId) => ({ brandId })) },
      },
    });
    await audit(me, "CREATE", "User", u.id, null, `Added staff ${name} (@${username})`, { roleId, allBrands, brandIds: ids });
    revalidatePath("/admin/users");
    return "Staff added. They can sign in now.";
  });
}

export async function updateUser(_p: Result, fd: FormData) {
  return run(async () => {
    const me = await guard("users", 3);
    const id = int(fd, "id");
    const before = await prisma.user.findUniqueOrThrow({ where: { id }, include: { brands: true, role: true } });
    const name = str(fd, "name");
    const roleId = int(fd, "roleId");
    const active = fd.get("active") === "on";
    const { allBrands, ids } = brandsFrom(fd);
    need(name, "Name can't be empty.");
    need(allBrands || ids.length, "Tick at least one brand, or give access to all brands.");
    const newRole = await prisma.role.findUniqueOrThrow({ where: { id: roleId } });
    if (before.role.locked && (!newRole.locked || !active)) {
      need((await adminsLeft(id)) > 0, "At least one active Administrator must remain.");
    }
    need(!(id === me.id && !active), "You can't deactivate your own account.");

    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { name, roleId, allBrands, active } }),
      prisma.userBrand.deleteMany({ where: { userId: id } }),
      ...(allBrands ? [] : [prisma.userBrand.createMany({ data: ids.map((brandId) => ({ userId: id, brandId })) })]),
      ...(active ? [] : [prisma.session.deleteMany({ where: { userId: id } })]),
    ]);
    await audit(me, "UPDATE", "User", id, null, `Edited staff ${name}`, {
      before: { name: before.name, roleId: before.roleId, allBrands: before.allBrands, active: before.active, brandIds: before.brands.map((b) => b.brandId) },
      after: { name, roleId, allBrands, active, brandIds: ids },
    });
    revalidatePath("/admin/users");
    return active ? "Saved." : "Saved. The account is disabled and signed out everywhere.";
  });
}

export async function resetPassword(_p: Result, fd: FormData) {
  return run(async () => {
    const me = await guard("users", 3);
    const id = int(fd, "id");
    const password = str(fd, "password");
    need(password.length >= 8, "Password needs at least 8 characters.");
    const u = await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
    await prisma.session.deleteMany({ where: { userId: id } });
    await audit(me, "UPDATE", "User", id, null, `Reset password for ${u.name}`);
    return "Password reset. They have been signed out and must use the new password.";
  });
}

function permsFrom(fd: FormData): Perms {
  const perms: Perms = {};
  for (const m of MODULES) {
    const v = Number(fd.get(`perm_${m.key}`) ?? 0) as Level;
    if ((m.levels as readonly number[]).includes(v) && v > 0) perms[m.key] = v;
  }
  return perms;
}

export async function saveRole(_p: Result, fd: FormData) {
  return run(async () => {
    const me = await guard("users", 3);
    const id = Number(str(fd, "id")) || null;
    const name = str(fd, "name");
    need(name, "Please give the role a name.");
    const perms = permsFrom(fd);
    need(Object.keys(perms).length, "Give this role access to at least one module.");
    if (id) {
      const r = await prisma.role.findUniqueOrThrow({ where: { id } });
      need(!r.locked, "The Administrator role always has full access and can't be changed.");
      await prisma.role.update({ where: { id }, data: { name, perms } });
      await audit(me, "UPDATE", "Role", id, null, `Edited role ${name}`, { before: r.perms, after: perms });
    } else {
      const r = await prisma.role.create({ data: { name, perms } });
      await audit(me, "CREATE", "Role", r.id, null, `Added role ${name}`, perms);
    }
    revalidatePath("/admin/users");
    return "Role saved.";
  });
}

export async function deleteRole(_p: Result, fd: FormData) {
  return run(async () => {
    const me = await guard("users", 3);
    const id = int(fd, "id");
    const r = await prisma.role.findUniqueOrThrow({ where: { id }, include: { _count: { select: { users: true } } } });
    need(!r.locked, "The Administrator role can't be deleted.");
    need(r._count.users === 0, "Move the staff in this role to another role first.");
    await prisma.role.delete({ where: { id } });
    await audit(me, "DELETE", "Role", id, null, `Deleted role ${r.name}`, r.perms);
    revalidatePath("/admin/users");
  });
}

/** Pause or turn back on from the staff list. A paused account is signed out at once. */
export async function setUserActive(_p: Result, fd: FormData) {
  return run(async () => {
    const me = await guard("users", 3);
    const id = int(fd, "id");
    const active = str(fd, "active") === "1";
    need(!(id === me.id && !active), "You can't deactivate your own account.");
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { role: true } });
    if (u.role.locked && !active) need((await adminsLeft(id)) > 0, "At least one active Administrator must remain.");
    await prisma.$transaction([prisma.user.update({ where: { id }, data: { active } }), ...(active ? [] : [prisma.session.deleteMany({ where: { userId: id } })])]);
    await audit(me, "UPDATE", "User", id, null, active ? `Turned on staff ${u.name}` : `Paused staff ${u.name}`, { active });
    revalidatePath("/admin/users");
    if (active) return "Account turned on. They can sign in again.";
    return "Account paused. They have been signed out and can't sign in.";
  });
}

/** Delete a staff account that never entered anything; anyone with records keeps their name on them, so pause them instead. */
export async function deleteUser(_p: Result, fd: FormData) {
  return run(async () => {
    const me = await guard("users", 3);
    const id = int(fd, "id");
    need(id !== me.id, "You can't delete your own account.");
    const u = await prisma.user.findUniqueOrThrow({
      where: { id },
      include: { role: true, _count: { select: { txnsEntered: true, claimsEntered: true, boxesEntered: true, expensesEntered: true, contacts: true, alertsDone: true } } },
    });
    if (u.role.locked) need((await adminsLeft(id)) > 0, "At least one active Administrator must remain.");
    const c = u._count;
    need(
      !(c.txnsEntered + c.claimsEntered + c.boxesEntered + c.expensesEntered + c.contacts + c.alertsDone),
      "This staff member has already entered data, so the account can't be deleted (their name stays on those records). Pause it instead.",
    );
    await prisma.user.delete({ where: { id } });
    await audit(me, "DELETE", "User", id, null, `Deleted staff ${u.name} (@${u.username})`, { roleId: u.roleId });
    revalidatePath("/admin/users");
    return "Account deleted.";
  });
}
