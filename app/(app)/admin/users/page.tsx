import type { Brand, Role } from "@prisma/client";
import { ActionButton, ActionForm, Dialog, Submit } from "@/components/client";
import { Card, Chip, Field, PageHeader, TableWrap, Tabs } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { dt } from "@/lib/format";
import type { T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { LEVELS, MODULES, levelOf, type Perms } from "@/lib/perms";
import { createUser, deleteRole, deleteUser, resetPassword, saveRole, setUserActive, updateUser } from "./actions";

function BrandAccess({ brands, all, picked, t }: { brands: Brand[]; all: boolean; picked: number[]; t: T }) {
  return (
    <fieldset className="group">
      <legend className="label">{t("Brand access")}</legend>
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input type="checkbox" name="allBrands" defaultChecked={all} className="h-4 w-4 accent-[var(--brand)]" />
        {t("All brands, including ones added later")}
      </label>
      {/* Greyed out while "All brands" is ticked: the ticks below don't count then. */}
      <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-line p-2.5 group-has-[[name=allBrands]:checked]:pointer-events-none group-has-[[name=allBrands]:checked]:opacity-40 sm:grid-cols-3">
        {brands.map((b) => (
          <label key={b.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="brandIds" value={b.id} defaultChecked={picked.includes(b.id)} className="h-4 w-4 accent-[var(--brand)]" />
            {b.name}
          </label>
        ))}
        {brands.length === 0 && <span className="text-xs text-muted">{t("No brands yet")}</span>}
      </div>
      <p className="hint">{t("Ignored when “All brands” is ticked.")}</p>
    </fieldset>
  );
}

function RoleSelect({ roles, value, t }: { roles: Role[]; value?: number; t: T }) {
  return (
    <select name="roleId" className="input" defaultValue={value ?? roles.find((r) => r.name === "Data entry")?.id} required>
      {roles.map((r) => (
        <option key={r.id} value={r.id}>
          {t(r.name)}
        </option>
      ))}
    </select>
  );
}

/** Same column widths for the pinned heading table and the module table, so they line up. */
const RoleCols = () => (
  <colgroup>
    <col />
    {LEVELS.map((l) => (
      <col key={l.value} className="w-[15%]" />
    ))}
  </colgroup>
);

function RoleEditor({ role, t }: { role?: Role; t: T }) {
  const perms = (role?.perms ?? {}) as Perms;
  return (
    <ActionForm action={saveRole} close>
      {role && <input type="hidden" name="id" value={role.id} />}
      {/* The name and the level headings stay at the top while the module list scrolls under them. */}
      <div className="sticky -top-5 z-10 -mx-5 -mt-5 border-b border-line bg-surface px-5 pt-5">
        <Field label={t("Role name")}>
          <input name="name" className="input" defaultValue={role?.name} required placeholder={t("e.g. Finance")} />
        </Field>
        <table className="tbl mt-4 table-fixed">
          <RoleCols />
          <thead>
            <tr>
              <th>{t("Module")}</th>
              {LEVELS.map((l) => (
                <th key={l.value} className="text-center">
                  {t(l.label)}
                </th>
              ))}
            </tr>
          </thead>
        </table>
      </div>
      <div>
        <table className="tbl table-fixed">
          <RoleCols />
          <tbody>
            {MODULES.map((m) => (
              <tr key={m.key}>
                <td>
                  <div className="font-medium">{t(m.label)}</div>
                  {m.hint && <div className="text-xs text-muted">{t(m.hint)}</div>}
                </td>
                {LEVELS.map((l) => (
                  <td key={l.value} className="text-center">
                    {(m.levels as readonly number[]).includes(l.value) ? (
                      <input
                        type="radio"
                        name={`perm_${m.key}`}
                        value={l.value}
                        defaultChecked={levelOf(perms, m.key) === l.value}
                        className="h-4 w-4 accent-[var(--brand)]"
                        aria-label={`${t(m.label)}: ${t(l.label)}`}
                      />
                    ) : (
                      <span className="text-muted">·</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end">
        <Submit>{t("Save role")}</Submit>
      </div>
    </ActionForm>
  );
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requirePage("users");
  const manage = can(user, "users", 3);
  const tab = (await searchParams).tab === "roles" ? "roles" : "staff";
  const [users, roles, brands, t] = await Promise.all([
    prisma.user.findMany({ include: { role: true, brands: { include: { brand: true } } }, orderBy: [{ active: "desc" }, { name: "asc" }] }),
    prisma.role.findMany({ include: { _count: { select: { users: true } } }, orderBy: { id: "asc" } }),
    prisma.brand.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    getT(),
  ]);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={t("Staff & roles")}
        desc={t("Each staff member has one role (what they can do) and a set of brands (which data they can see).")}
        actions={
          manage &&
          (tab === "staff" ? (
            <Dialog label={"+ " + t("Add staff")} title={t("Add staff")} className="btn btn-primary">
              <ActionForm action={createUser} close className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Name")}>
                    <input name="name" className="input" required />
                  </Field>
                  <Field label={t("Username")} hint={t("Used to sign in.")}>
                    <input name="username" className="input lowercase" required pattern="[A-Za-z0-9._\-]{3,40}" autoComplete="off" />
                  </Field>
                  <Field label={t("Password")} hint={t("At least 8 characters. They can change it later.")}>
                    <input name="password" className="input" required minLength={8} autoComplete="new-password" />
                  </Field>
                  <Field label={t("Role")}>
                    <RoleSelect roles={roles} t={t} />
                  </Field>
                </div>
                <BrandAccess brands={brands} all={false} picked={[]} t={t} />
                <div className="flex justify-end">
                  <Submit>{t("Add staff")}</Submit>
                </div>
              </ActionForm>
            </Dialog>
          ) : (
            <Dialog label={"+ " + t("Add role")} title={t("Add role")} className="btn btn-primary" wide>
              <RoleEditor t={t} />
            </Dialog>
          ))
        }
      />
      <Tabs
        items={[
          { href: "/admin/users", label: t("Staff"), active: tab === "staff", count: users.filter((u) => u.active).length },
          { href: "/admin/users?tab=roles", label: t("Roles & permissions"), active: tab === "roles", count: roles.length },
        ]}
      />

      {tab === "staff" ? (
        <Card flush>
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Name")}</th>
                  <th>{t("Role")}</th>
                  <th>{t("Brands")}</th>
                  <th>{t("Last sign-in")}</th>
                  <th>{t("Status")}</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.active ? "" : "opacity-60"}>
                    <td>
                      <div className="font-medium">{u.name}</div>
                      <div className="text-xs text-muted">@{u.username}</div>
                    </td>
                    <td>{t(u.role.name)}</td>
                    <td className="max-w-64">{u.allBrands ? <Chip tone="brand">{t("All brands")}</Chip> : u.brands.map((b) => b.brand.name).join(", ") || "–"}</td>
                    <td className="whitespace-nowrap text-ink-2">{dt(u.lastLoginAt)}</td>
                    <td>{u.active ? <Chip tone="good">{t("Active")}</Chip> : <Chip>{t("Disabled")}</Chip>}</td>
                    {manage && (
                      <td className="r space-x-1">
                        <Dialog label={t("Edit")} title={t("Edit {name}", { name: u.name })}>
                          <ActionForm action={updateUser} close className="space-y-3">
                            <input type="hidden" name="id" value={u.id} />
                            <div className="grid grid-cols-2 gap-3">
                              <Field label={t("Name")}>
                                <input name="name" className="input" defaultValue={u.name} required />
                              </Field>
                              <Field label={t("Role")}>
                                <RoleSelect roles={roles} value={u.roleId} t={t} />
                              </Field>
                            </div>
                            <BrandAccess brands={brands} all={u.allBrands} picked={u.brands.map((b) => b.brandId)} t={t} />
                            <label className="flex items-center gap-2 text-sm">
                              <input type="checkbox" name="active" defaultChecked={u.active} className="h-4 w-4 accent-[var(--brand)]" />
                              {t("Account active (untick to block sign-in immediately)")}
                            </label>
                            <div className="flex justify-end">
                              <Submit>{t("Save")}</Submit>
                            </div>
                          </ActionForm>
                        </Dialog>
                        <Dialog label={t("Reset password")} title={t("Reset password for {name}", { name: u.name })}>
                          <ActionForm action={resetPassword} className="space-y-3">
                            <input type="hidden" name="id" value={u.id} />
                            <Field label={t("New password")} hint={t("At least 8 characters. Give it to them privately.")}>
                              <input name="password" className="input" required minLength={8} autoComplete="new-password" />
                            </Field>
                            <div className="flex justify-end">
                              <Submit>{t("Reset password")}</Submit>
                            </div>
                          </ActionForm>
                        </Dialog>
                        {u.id !== user.id && (
                          <>
                            {u.active ? (
                              <ActionButton
                                action={setUserActive}
                                fields={{ id: u.id, active: 0 }}
                                question={t("Pause {name}'s account? They are signed out at once and can't sign in until you turn it back on.", { name: u.name })}
                              >
                                {t("Pause")}
                              </ActionButton>
                            ) : (
                              <ActionButton action={setUserActive} fields={{ id: u.id, active: 1 }}>
                                {t("Turn on")}
                              </ActionButton>
                            )}
                            <ActionButton action={deleteUser} fields={{ id: u.id }} question={t("Delete {name}'s account? This can't be undone.", { name: u.name })} className="btn btn-sm text-critical-ink">
                              {t("Delete")}
                            </ActionButton>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {roles.map((r) => {
            const perms = r.perms as Perms;
            const granted = MODULES.filter((m) => levelOf(perms, m.key) > 0);
            return (
              <Card
                key={r.id}
                title={t(r.name)}
                note={t("{n} staff", { n: r._count.users })}
                action={
                  manage &&
                  !r.locked && (
                    <span className="space-x-1">
                      <Dialog label={t("Edit")} title={t("Edit role: {name}", { name: t(r.name) })} wide>
                        <RoleEditor role={r} t={t} />
                      </Dialog>
                      {r._count.users === 0 && (
                        <ActionButton action={deleteRole} fields={{ id: r.id }} question={t("Delete the role “{name}”?", { name: t(r.name) })}>
                          {t("Delete")}
                        </ActionButton>
                      )}
                    </span>
                  )
                }
              >
                {r.locked ? (
                  <p className="text-sm text-ink-2">{t("Full access to everything. This role can't be changed, so there is always someone who can manage the system.")}</p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {granted.map((m) => (
                      <li key={m.key}>
                        <Chip tone={levelOf(perms, m.key) === 3 ? "brand" : "neutral"}>
                          {t(m.label)} · {t(LEVELS[levelOf(perms, m.key)].label)}
                        </Chip>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
