import { Prisma } from "@prisma/client";
import { BatchEntry } from "@/components/batch-entry";
import { ActionButton, ActionForm, AutoSelect, Dialog, Submit } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Chip, Empty, Field, Info, PageHeader, TableWrap, Tabs } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { dateOnly, dateRange, parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { d10, dt, money, money0, n, pct } from "@/lib/format";
import { converted, dailyRows, groupBy, sum } from "@/lib/metrics";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { deleteEntry, loadLists, saveBatch, updateEntry } from "../entry/actions";
import { saveCategory, toggleCategory } from "./actions";
import type { T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("expenses");
  const sp = await searchParams;
  const tab = ["pl", "entries", "categories"].includes(sp.tab ?? "") ? sp.tab! : "pl";
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const range = parseRange(sp, "month");
  const cats = await prisma.expenseCategory.findMany({ orderBy: [{ kind: "asc" }, { sort: "asc" }, { name: "asc" }] });
  const canAdd = can(user, "expenses", 2);
  const full = can(user, "expenses", 3);
  const tabHref = (t: string) => `/expenses?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "tab")) as Record<string, string>), tab: t })}`;

  return (
    <div className="max-w-[1400px]">
      <PageHeader title={t("Expenses & profit")} desc={t("Company costs and income per brand, and the profit statement they add up to.")} />
      <Tabs
        items={[
          { href: tabHref("pl"), label: t("Profit statement"), active: tab === "pl" },
          { href: tabHref("entries"), label: t("Expense & income entries"), active: tab === "entries" },
          { href: tabHref("categories"), label: t("Categories"), active: tab === "categories", count: cats.filter((c) => c.active).length },
        ]}
      />
      {tab !== "categories" && (
        <div className="mb-4">
          <RangeBar path="/expenses" range={range} params={{ ...sp, tab }} />
        </div>
      )}

      {tab === "pl" && <ProfitStatement scope={scope} settings={settings} range={range} cats={cats} t={t} />}

      {tab === "entries" && (
        <div className="space-y-5">
          {canAdd && (
            <BatchEntry
              kind="expense"
              cols={[
                {
                  key: "category",
                  label: t("Category"),
                  type: "select",
                  required: true,
                  width: "12rem",
                  options: cats.filter((c) => c.active).map((c) => ({ value: String(c.id), label: `${t(c.name)}${c.kind === "INCOME" ? ` (${t("income")})` : ""}` })),
                },
                { key: "date", label: t("Date"), type: "date", width: "9rem" },
                { key: "amount", label: t("Amount"), type: "amount", required: true, width: "8rem" },
                { key: "note", label: t("Note"), type: "text", width: "16rem" },
              ]}
              brands={scope.brands.map((b) => ({ id: b.id, name: b.name, currency: b.currency }))}
              brandId={scope.current?.id ?? (scope.brands.length === 1 ? scope.brands[0].id : null)}
              save={saveBatch}
              loadLists={loadLists}
              totals={[{ col: "amount", label: t("Total") }]}
              note={t("For costs shared by several brands, enter each brand's share separately.")}
            />
          )}
          <EntryList brandIds={scope.brandIds} range={range} cats={cats} sp={sp} full={full} userId={user.id} brandName={scope.brandName} brandCurrency={scope.brandCurrency} multi={!scope.current} t={t} />
        </div>
      )}

      {tab === "categories" && (
        <Card
          flush
          title={t("Categories")}
          note={t("Hidden categories keep their history but can't be picked for new entries.")}
          action={
            full && (
              <Dialog label={"+ " + t("Add category")} title={t("Add category")} className="btn btn-primary btn-sm">
                <CategoryForm t={t} />
              </Dialog>
            )
          }
        >
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Name")}</th>
                  <th>{t("Type")}</th>
                  <th>{t("Status")}</th>
                  {full && <th />}
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => (
                  <tr key={c.id} className={c.active ? "" : "opacity-60"}>
                    <td className="font-medium">{t(c.name)}</td>
                    <td>{c.kind === "INCOME" ? <Chip tone="good">{t("Income")}</Chip> : <Chip>{t("Expense")}</Chip>}</td>
                    <td>{c.active ? t("In use") : t("Hidden")}</td>
                    {full && (
                      <td className="r space-x-1">
                        <Dialog label={t("Edit")} title={t("Edit {name}", { name: t(c.name) })}>
                          <CategoryForm c={c} t={t} />
                        </Dialog>
                        <ActionButton action={toggleCategory} fields={{ id: c.id }}>
                          {c.active ? t("Hide") : t("Restore")}
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </div>
  );
}

function CategoryForm({ c, t }: { c?: { id: number; name: string; kind: string }; t: T }) {
  return (
    <ActionForm action={saveCategory} close className="space-y-3">
      {c && <input type="hidden" name="id" value={c.id} />}
      <Field label={t("Name")}>
        <input name="name" className="input" defaultValue={c?.name} required placeholder={t("e.g. Office rental")} />
      </Field>
      <Field label={t("Type")}>
        <select name="kind" className="input" defaultValue={c?.kind ?? "EXPENSE"}>
          <option value="EXPENSE">{t("Expense (reduces profit)")}</option>
          <option value="INCOME">{t("Income (adds to profit)")}</option>
        </select>
      </Field>
      <div className="flex justify-end">
        <Submit>{t("Save")}</Submit>
      </div>
    </ActionForm>
  );
}

async function ProfitStatement({
  scope,
  settings,
  range,
  cats,
  t,
}: {
  scope: Awaited<ReturnType<typeof getScope>>;
  settings: Awaited<ReturnType<typeof getSettings>>;
  range: { from: string; to: string };
  cats: { id: number; name: string; kind: string }[];
  t: T;
}) {
  const ids = scope.brandIds;
  if (!ids.length) return null;
  const [days, byCat] = await Promise.all([
    dailyRows(ids, range).then((r) => converted(r, scope.rate)),
    prisma.$queryRaw<{ brandId: number; categoryId: number; amt: unknown }[]>`
      SELECT brandId, categoryId, SUM(amount) AS amt FROM \`Expense\`
      WHERE brandId IN (${Prisma.join(ids)}) AND date >= ${dateOnly(range.from)} AND date <= ${dateOnly(range.to)}
      GROUP BY brandId, categoryId`,
  ]);
  const cols = scope.current ? [{ id: scope.current.id, name: scope.current.name }] : scope.brands.map((b) => ({ id: b.id, name: b.name }));
  const perBrand = groupBy(days, (d) => d.brandId);
  const tot = new Map(cols.map((c) => [c.id, sum(perBrand.get(c.id) ?? [], settings.profit)]));
  const total = sum(days, settings.profit);
  const catAmt = (brandId: number | null, catId: number) =>
    byCat.filter((x) => x.categoryId === catId && (brandId == null || x.brandId === brandId)).reduce((a, x) => a + n(x.amt as number) * scope.rate(x.brandId), 0);
  const usedCats = cats.filter((c) => byCat.some((x) => x.categoryId === c.id));
  const cur = scope.currency;
  const p = settings.profit;
  const many = cols.length > 1;

  type Line = { label: string; v: (id: number | null) => number; sign?: "+" | "−" | "="; strong?: boolean; muted?: boolean };
  const lines: Line[] = [
    { label: t("Deposits"), v: (id) => (id == null ? total : tot.get(id)!).deposit },
    { label: t("Withdrawals"), sign: "−", v: (id) => (id == null ? total : tot.get(id)!).withdraw },
    { label: t("Win/Loss"), sign: "=", strong: true, v: (id) => (id == null ? total : tot.get(id)!).winlose },
    ...(p.income ? usedCats.filter((c) => c.kind === "INCOME").map((c): Line => ({ label: t(c.name), sign: "+", v: (id) => catAmt(id, c.id) })) : []),
    ...(p.fees ? [{ label: t("PG / bank fees"), sign: "−" as const, v: (id: number | null) => (id == null ? total : tot.get(id)!).fees }] : []),
    ...(p.promos ? [{ label: t("Promotions"), sign: "−" as const, v: (id: number | null) => (id == null ? total : tot.get(id)!).promo }] : []),
    ...(p.expenses ? usedCats.filter((c) => c.kind === "EXPENSE").map((c): Line => ({ label: t(c.name), sign: "−", v: (id) => catAmt(id, c.id) })) : []),
    { label: t("Net profit"), sign: "=", strong: true, v: (id) => (id == null ? total : tot.get(id)!).profit },
  ];
  const margin = (id: number | null) => {
    const x = id == null ? total : tot.get(id)!;
    return x.deposit ? (x.profit / x.deposit) * 100 : 0;
  };
  const LEFT: Record<string, string> = { fees: t("fees"), promos: t("promotions"), expenses: t("expenses"), income: t("other income") };
  const left = (["fees", "promos", "expenses", "income"] as const).filter((k) => !p[k]).map((k) => LEFT[k]);

  return (
    <Card
      flush
      title={t("Profit statement")}
      note={`${range.from} ~ ${range.to} · ${cur}`}
      action={
        <Info>
          {t("Win/Loss = deposits − withdrawals. Net profit then adds other income and takes off fees, promotions and expenses. Amounts from brands in other currencies are converted with each brand's rate.")}
          {left.length ? " " + t("Switched off in Settings → General: {items}.", { items: left.join(", ") }) : ""}
        </Info>
      }
    >
      {total.deposit + total.withdraw + total.expense + total.income === 0 ? (
        <Empty title={t("Nothing recorded in this period")} />
      ) : (
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th />
                {cols.map((c) => (
                  <th key={c.id} className="r">
                    {c.name}
                  </th>
                ))}
                {many && <th className="r">{t("All brands")}</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.label} className={l.strong ? "bg-surface-2/60 font-semibold" : ""}>
                  <td className="whitespace-nowrap">
                    <span className="inline-block w-4 text-muted">{l.sign && l.sign !== "=" ? l.sign : ""}</span>
                    {l.label}
                  </td>
                  {cols.map((c) => {
                    const v = l.v(c.id);
                    return (
                      <td key={c.id} className={`r ${l.strong && v < 0 ? "text-critical-ink" : ""}`}>
                        {money0(v, cur)}
                      </td>
                    );
                  })}
                  {many && <td className={`r ${l.strong && l.v(null) < 0 ? "text-critical-ink" : ""}`}>{money0(l.v(null), cur)}</td>}
                </tr>
              ))}
              <tr>
                <td className="text-ink-2">
                  <span className="inline-block w-4" />
                  {t("Margin (net profit ÷ deposits)")}
                </td>
                {cols.map((c) => (
                  <td key={c.id} className="r text-ink-2">
                    {pct(margin(c.id))}
                  </td>
                ))}
                {many && <td className="r text-ink-2">{pct(margin(null))}</td>}
              </tr>
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

async function EntryList({
  brandIds,
  range,
  cats,
  sp,
  full,
  userId,
  brandName,
  brandCurrency,
  multi,
  t,
}: {
  brandIds: number[];
  range: { from: string; to: string };
  cats: { id: number; name: string; kind: string; active: boolean }[];
  sp: Record<string, string | undefined>;
  full: boolean;
  userId: number;
  brandName: (id: number) => string;
  brandCurrency: (id: number) => string;
  multi: boolean;
  t: T;
}) {
  const rows = await prisma.expense.findMany({
    where: { brandId: { in: brandIds }, date: dateRange(range), ...(sp.cat ? { categoryId: Number(sp.cat) } : {}) },
    include: { category: true },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: 500,
  });
  const recent = cutoff();
  return (
    <Card
      flush
      title={t("{n} entries", { n: `${rows.length}${rows.length === 500 ? "+" : ""}` })}
      action={
        <form action="/expenses" className="flex gap-2">
          {Object.entries(sp)
            .filter(([k, v]) => v && k !== "cat")
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <AutoSelect name="cat" defaultValue={sp.cat ?? ""} className="input h-8 w-auto">
            <option value="">{t("All categories")}</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {t(c.name)}
              </option>
            ))}
          </AutoSelect>
        </form>
      }
    >
      {rows.length === 0 ? (
        <Empty title={t("No expenses or income in this period")} />
      ) : (
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("Date")}</th>
                {multi && <th>{t("Brand")}</th>}
                <th>{t("Category")}</th>
                <th className="r">{t("Amount")}</th>
                <th>{t("Note")}</th>
                <th>{t("Entered")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const mine = e.createdById === userId && e.createdAt.getTime() > recent;
                return (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">{d10(e.date)}</td>
                    {multi && <td className="text-ink-2">{brandName(e.brandId)}</td>}
                    <td>
                      {t(e.category.name)} {e.category.kind === "INCOME" && <Chip tone="good">{t("Income")}</Chip>}
                    </td>
                    <td className="r">{money(e.amount, brandCurrency(e.brandId))}</td>
                    <td className="max-w-72 truncate text-ink-2">{e.note ?? ""}</td>
                    <td className="whitespace-nowrap text-xs text-muted">{dt(e.createdAt)}</td>
                    <td className="r space-x-1">
                      {(full || mine) && (
                        <>
                          <Dialog label={t("Edit")} title={t("Edit entry")}>
                            <ActionForm action={updateEntry} close className="space-y-3">
                              <input type="hidden" name="kind" value="expense" />
                              <input type="hidden" name="id" value={e.id} />
                              <div className="grid grid-cols-2 gap-3">
                                <Field label={t("Category")}>
                                  <select name="category" className="input" defaultValue={e.categoryId}>
                                    {cats.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {t(c.name)}
                                      </option>
                                    ))}
                                  </select>
                                </Field>
                                <Field label={t("Date")}>
                                  <input name="date" type="date" className="input" defaultValue={d10(e.date)} />
                                </Field>
                                <Field label={t("Amount")}>
                                  <input name="amount" className="input" defaultValue={n(e.amount)} inputMode="decimal" />
                                </Field>
                                <Field label={t("Note")}>
                                  <input name="note" className="input" defaultValue={e.note ?? ""} />
                                </Field>
                              </div>
                              <div className="flex justify-end">
                                <Submit>{t("Save")}</Submit>
                              </div>
                            </ActionForm>
                          </Dialog>
                          <ActionButton action={deleteEntry} fields={{ kind: "expense", id: e.id }} question={t("Delete this entry?")}>
                            {t("Delete")}
                          </ActionButton>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function cutoff() {
  return Date.now() - 3600_000;
}
