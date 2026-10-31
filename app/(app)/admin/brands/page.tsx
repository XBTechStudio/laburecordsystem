import Link from "next/link";
import { ActionButton, ActionForm, Dialog, Submit } from "@/components/client";
import { Card, Chip, Empty, Field, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { count, n } from "@/lib/format";
import type { T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";
import { createBrand, toggleBrand, updateBrand } from "./actions";

const CURRENCIES = ["SGD", "MYR", "AUD", "USDT", "USD", "THB", "IDR", "PHP", "VND", "CNY"];

function BrandFields({ b, base, t }: { b?: { id: number; name: string; currency: string; fxRate: { toString(): string } }; base: string; t: T }) {
  return (
    <div className="space-y-3">
      {b && <input type="hidden" name="id" value={b.id} />}
      <Field label={t("Brand name")}>
        <input name="name" className="input" defaultValue={b?.name} required placeholder={t("e.g. Brand A")} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Currency")} hint={t("What this brand's amounts are entered in.")}>
          <input name="currency" className="input uppercase" list="currencies" defaultValue={b?.currency ?? base} maxLength={5} required />
        </Field>
        <Field label={t("Rate to {base}", { base })} hint={t("1 unit of this currency = ? {base}. Used when brands are combined.", { base })}>
          <input name="fxRate" className="input" inputMode="decimal" defaultValue={b ? n(b.fxRate) : 1} required />
        </Field>
      </div>
      <datalist id="currencies">
        {CURRENCIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  );
}

export default async function BrandsPage() {
  const user = await requirePage("brands");
  const manage = can(user, "brands", 3);
  const [brands, settings, players, staff, t] = await Promise.all([
    prisma.brand.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    getSettings(),
    prisma.player.groupBy({ by: ["brandId"], _count: true }),
    prisma.userBrand.groupBy({ by: ["brandId"], _count: true }),
    getT(),
  ]);
  const links = new Map((await prisma.platformLink.findMany({ select: { brandId: true, enabled: true, lastError: true } })).map((l) => [l.brandId, l]));
  const pc = new Map(players.map((p) => [p.brandId, p._count]));
  const sc = new Map(staff.map((s) => [s.brandId, s._count]));
  const base = settings.baseCurrency;

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={t("Brands")}
        desc={t("Every record in the system belongs to a brand. Deactivated brands keep their history but disappear from menus.")}
        actions={
          manage && (
            <Dialog label={"+ " + t("Add brand")} title={t("Add brand")} className="btn btn-primary">
              <ActionForm action={createBrand} close>
                <BrandFields base={base} t={t} />
                <div className="mt-4 flex justify-end">
                  <Submit>{t("Add brand")}</Submit>
                </div>
              </ActionForm>
            </Dialog>
          )
        }
      />
      <Card flush>
        {brands.length === 0 ? (
          <Empty title={t("No brands yet")}>{t("Add your first brand to start entering data.")}</Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Brand")}</th>
                  <th>{t("Currency")}</th>
                  <th className="r">{t("Players")}</th>
                  <th className="r">{t("Staff with access")}</th>
                  <th>{t("Status")}</th>
                  <th>{t("Platform API")}</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {brands.map((b) => (
                  <tr key={b.id} className={b.active ? "" : "opacity-60"}>
                    <td className="font-medium">{b.name}</td>
                    <td>
                      {b.currency}
                      {b.currency !== base && (
                        <span className="ml-1 text-xs text-muted">
                          (1 = {n(b.fxRate)} {base})
                        </span>
                      )}
                    </td>
                    <td className="r">{count(pc.get(b.id) ?? 0)}</td>
                    <td className="r">{count(sc.get(b.id) ?? 0)}</td>
                    <td>{b.active ? <Chip tone="good">{t("Active")}</Chip> : <Chip>{t("Inactive")}</Chip>}</td>
                    <td>
                      {(() => {
                        const l = links.get(b.id);
                        const chip = !l ? <span className="text-muted">–</span> : !l.enabled ? <Chip>{t("Paused")}</Chip> : l.lastError ? <Chip tone="critical">{t("Error")}</Chip> : <Chip tone="good">{t("Running")}</Chip>;
                        return manage ? (
                          <Link href={`/admin/brands/${b.id}/platform`} className="hover:underline">
                            {l ? chip : t("Connect")}
                          </Link>
                        ) : (
                          chip
                        );
                      })()}
                    </td>
                    {manage && (
                      <td className="r space-x-1">
                        <Dialog label={t("Edit")} title={t("Edit {name}", { name: b.name })}>
                          <ActionForm action={updateBrand} close>
                            <BrandFields b={b} base={base} t={t} />
                            <div className="mt-4 flex justify-end">
                              <Submit>{t("Save")}</Submit>
                            </div>
                          </ActionForm>
                        </Dialog>
                        <ActionButton
                          action={toggleBrand}
                          fields={{ id: b.id }}
                          question={b.active ? t("Deactivate {name}? Its data stays, but staff can no longer enter data for it.", { name: b.name }) : undefined}
                        >
                          {b.active ? t("Deactivate") : t("Reactivate")}
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
