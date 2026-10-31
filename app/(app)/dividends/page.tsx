import { BrandFilter } from "@/components/brand-filter";
import Link from "next/link";
import { ActionButton, ActionForm, Dialog, Submit } from "@/components/client";
import { Card, Chip, Empty, Field, Info, PageHeader, TableWrap, Tabs } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { periodLabel, recentPeriods, ruleFor } from "@/lib/dividends";
import { d10, money0, n } from "@/lib/format";
import { LOCALE, tk, type T } from "@/lib/i18n";
import { getLang, getT } from "@/lib/i18n-server";
import { getScope } from "@/lib/scope";
import { saveRule, saveShareholder, saveShares, toggleShareholder } from "./actions";

const TABS = [
  ["overview", tk("Overview")],
  ["settlements", tk("Settlements")],
  ["shares", tk("Brand shares")],
  ["rules", tk("Rules")],
  ["holders", tk("Shareholders")],
] as const;

export default async function DividendsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("dividends");
  const sp = await searchParams;
  const tab = TABS.find(([k]) => k === sp.tab)?.[0] ?? "overview";
  const [scope, t, lang] = await Promise.all([getScope(user), getT(), getLang()]);
  const manage = can(user, "dividends", 3);
  const ids = scope.brandIds;
  const loc = LOCALE[lang];

  return (
    <div className="max-w-6xl">
      <PageHeader title={t("Shareholder dividends")} desc={t("Shares per brand, the rules for each brand's profit split, and what each shareholder is owed and has been paid.")} actions={<BrandFilter />} />
      <Tabs items={TABS.map(([k, label]) => ({ href: `/dividends?tab=${k}`, label: t(label), active: tab === k }))} />
      {tab === "overview" && <Overview ids={ids} rate={scope.rate} multi={!scope.current} currency={scope.currency} t={t} loc={loc} />}
      {tab === "settlements" && <Settlements ids={ids} manage={manage} brands={scope.brands} brandName={scope.brandName} brandCurrency={scope.brandCurrency} t={t} loc={loc} />}
      {tab === "shares" && <Shares ids={ids} manage={manage} brands={scope.brands} t={t} />}
      {tab === "rules" && <Rules manage={manage} brands={scope.brands} t={t} />}
      {tab === "holders" && <Holders manage={manage} t={t} />}
    </div>
  );
}

async function Overview({ ids, rate, multi, currency, t, loc }: { ids: number[]; rate: (id: number) => number; multi: boolean; currency: string; t: T; loc: string }) {
  const lines = await prisma.settlementLine.findMany({
    where: { settlement: { brandId: { in: ids } } },
    include: { shareholder: true, settlement: { include: { brand: true } } },
  });
  if (lines.length === 0)
    return (
      <Card>
        <Empty title={t("No settlements yet")}>
          {t("Set up shareholders and brand shares, then run a settlement for a finished month under Settlements.")}
          <div className="mt-3 flex justify-center gap-2">
            <Link className="btn btn-sm" href="/dividends?tab=holders">
              {t("Shareholders")}
            </Link>
            <Link className="btn btn-sm" href="/dividends?tab=shares">
              {t("Brand shares")}
            </Link>
            <Link className="btn btn-sm" href="/dividends?tab=settlements">
              {t("Settlements")}
            </Link>
          </div>
        </Empty>
      </Card>
    );
  const by = new Map<number, { name: string; due: number; paid: number; brands: Set<string> }>();
  for (const l of lines) {
    const k = rate(l.settlement.brandId);
    const s = by.get(l.shareholderId) ?? { name: l.shareholder.name, due: 0, paid: 0, brands: new Set() };
    s.due += n(l.amount) * k;
    s.paid += n(l.paid) * k;
    s.brands.add(l.settlement.brand.name);
    by.set(l.shareholderId, s);
  }
  const rows = [...by.entries()].sort((a, b) => b[1].due - b[1].paid - (a[1].due - a[1].paid));
  const tot = rows.reduce((a, [, s]) => ({ due: a.due + s.due, paid: a.paid + s.paid }), { due: 0, paid: 0 });
  const unpaid = lines.filter((l) => n(l.amount) - n(l.paid) > 0.005).sort((a, b) => a.settlement.periodStart.getTime() - b.settlement.periodStart.getTime());

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {[
          ["due", t("Distributed so far"), tot.due],
          ["paid", t("Paid"), tot.paid],
          ["left", t("Still to pay"), tot.due - tot.paid],
        ].map(([k, l, v]) => (
          <div key={String(k)} className="card p-4">
            <div className="text-xs text-ink-2">{l}</div>
            <div className={`mt-1 text-xl font-semibold ${k === "left" && Number(v) > 0 ? "text-warning-ink" : ""}`}>{money0(Number(v), currency)}</div>
          </div>
        ))}
      </div>
      <Card flush title={t("By shareholder")} note={multi ? t("All brands, in {cur}", { cur: currency }) : undefined}>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("Shareholder")}</th>
                <th>{t("Brands")}</th>
                <th className="r">{t("Entitled")}</th>
                <th className="r">{t("Paid")}</th>
                <th className="r">{t("Unpaid")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([id, s]) => (
                <tr key={id}>
                  <td className="font-medium">{s.name}</td>
                  <td className="text-ink-2">{[...s.brands].join(", ")}</td>
                  <td className="r">{money0(s.due, currency)}</td>
                  <td className="r">{money0(s.paid, currency)}</td>
                  <td className={`r font-medium ${s.due - s.paid > 0.005 ? "text-warning-ink" : "text-muted"}`}>{money0(s.due - s.paid, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      {unpaid.length > 0 && (
        <Card flush title={t("Waiting to be paid")} note={t("Oldest first")}>
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Period")}</th>
                  <th>{t("Brand")}</th>
                  <th>{t("Shareholder")}</th>
                  <th className="r">{t("Unpaid")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {unpaid.map((l) => (
                  <tr key={l.id}>
                    <td>{periodLabel(d10(l.settlement.periodStart), d10(l.settlement.periodEnd), loc)}</td>
                    <td>{l.settlement.brand.name}</td>
                    <td>{l.shareholder.name}</td>
                    <td className="r font-medium">{money0(n(l.amount) - n(l.paid), l.settlement.brand.currency)}</td>
                    <td className="r">
                      <Link className="btn btn-sm" href={`/dividends/${l.settlementId}`}>
                        {t("Open")}
                      </Link>
                    </td>
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

async function Settlements({
  ids,
  manage,
  brands,
  brandName,
  brandCurrency,
  t,
  loc,
}: {
  ids: number[];
  manage: boolean;
  brands: { id: number; name: string }[];
  brandName: (id: number) => string;
  brandCurrency: (id: number) => string;
  t: T;
  loc: string;
}) {
  const list = await prisma.settlement.findMany({ where: { brandId: { in: ids } }, include: { lines: true }, orderBy: [{ periodStart: "desc" }, { brandId: "asc" }] });
  const rules = await Promise.all(brands.map(async (b) => ({ b, rule: await ruleFor(b.id) })));
  return (
    <div className="space-y-5">
      {manage && (
        <Card title={t("Run a settlement")} note={t("You'll see the full calculation before anything is saved")}>
          <div className="grid gap-3 md:grid-cols-2">
            {rules.map(({ b, rule }) => (
              <form key={b.id} action="/dividends/settle" className="flex items-end gap-2 rounded-lg border border-line p-3">
                <input type="hidden" name="brand" value={b.id} />
                <label className="block flex-1">
                  <span className="label">
                    {b.name} · {rule.period === "MONTHLY" ? t("monthly") : t("quarterly")}
                  </span>
                  <select name="period" className="input">
                    {recentPeriods(rule.period).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn btn-primary">{t("Preview")} →</button>
              </form>
            ))}
          </div>
        </Card>
      )}
      <Card flush title={t("Settlements")}>
        {list.length === 0 ? (
          <Empty title={t("No settlements yet")} />
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Period")}</th>
                  <th>{t("Brand")}</th>
                  <th className="r">{t("Profit")}</th>
                  <th className="r">{t("Loss carried in")}</th>
                  <th className="r">{t("Distributed")}</th>
                  <th className="r">{t("Unpaid")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const cur = brandCurrency(s.brandId);
                  const unpaid = s.lines.reduce((a, l) => a + n(l.amount) - n(l.paid), 0);
                  return (
                    <tr key={s.id}>
                      <td className="font-medium">{periodLabel(d10(s.periodStart), d10(s.periodEnd), loc)}</td>
                      <td>{brandName(s.brandId)}</td>
                      <td className={`r ${n(s.profit) < 0 ? "text-critical-ink" : ""}`}>{money0(s.profit, cur)}</td>
                      <td className="r text-ink-2">{n(s.carriedIn) ? money0(s.carriedIn, cur) : "–"}</td>
                      <td className="r font-medium">{money0(s.distributable, cur)}</td>
                      <td className="r">{unpaid > 0.005 ? <Chip tone="warning">{money0(unpaid, cur)}</Chip> : <Chip tone="good">{t("Paid")}</Chip>}</td>
                      <td className="r">
                        <Link href={`/dividends/${s.id}`} className="btn btn-sm">
                          {t("Open")}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

async function Shares({ ids, manage, brands, t }: { ids: number[]; manage: boolean; brands: { id: number; name: string }[]; t: T }) {
  const [holdings, holders] = await Promise.all([
    prisma.holding.findMany({ where: { brandId: { in: ids } }, include: { shareholder: true }, orderBy: [{ effectiveFrom: "desc" }, { percent: "desc" }] }),
    prisma.shareholder.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
  ]);
  if (holders.length === 0)
    return (
      <Card>
        <Empty title={t("Add shareholders first")}>
          <Link className="link" href="/dividends?tab=holders">
            {t("Add the people who own shares under Shareholders.")}
          </Link>
        </Empty>
      </Card>
    );
  const today = todayStr();
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {brands.map((b) => {
        const mine = holdings.filter((h) => h.brandId === b.id);
        const current = mine.filter((h) => !h.effectiveTo);
        const past = mine.filter((h) => h.effectiveTo);
        const total = current.reduce((a, h) => a + n(h.percent), 0);
        const pctOf = (sid: number) => current.find((h) => h.shareholderId === sid);
        return (
          <Card
            key={b.id}
            title={b.name}
            note={current.length ? t("{held}% held · {rest}% company", { held: total, rest: (100 - total).toFixed(2).replace(/\.00$/, "") }) : t("No shares set")}
            action={
              manage && (
                <Dialog label={t("Change shares")} title={t("Shares in {name}", { name: b.name })}>
                  <ActionForm action={saveShares} close className="space-y-3">
                    <input type="hidden" name="brandId" value={b.id} />
                    <Field label={t("New shares start on")} hint={t("Settlements for periods ending before this date keep the old shares.")}>
                      <input type="date" name="from" className="input w-48" defaultValue={today} required />
                    </Field>
                    <div className="space-y-2">
                      {holders.map((s) => (
                        <label key={s.id} className="flex items-center gap-3 text-sm">
                          <span className="flex-1">{s.name}</span>
                          <input name={`pct_${s.id}`} className="input w-24 text-right" inputMode="decimal" defaultValue={pctOf(s.id) ? n(pctOf(s.id)!.percent) : ""} placeholder="0" />
                          <span className="text-ink-2">%</span>
                        </label>
                      ))}
                    </div>
                    <p className="text-xs text-muted">{t("Leave empty for no share. Anything under 100% in total stays with the company.")}</p>
                    <div className="flex justify-end">
                      <Submit>{t("Save shares")}</Submit>
                    </div>
                  </ActionForm>
                </Dialog>
              )
            }
          >
            {current.length === 0 ? (
              <p className="text-sm text-ink-2">{t("Nobody holds shares in this brand yet.")}</p>
            ) : (
              <ul className="space-y-2">
                {current.map((h) => (
                  <li key={h.id} className="text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium">{h.shareholder.name}</span>
                      <span className="tabular-nums">{n(h.percent)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-[var(--series-1)]" style={{ width: `${n(h.percent)}%` }} />
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{t("since {date}", { date: d10(h.effectiveFrom) })}</div>
                  </li>
                ))}
              </ul>
            )}
            {past.length > 0 && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-xs text-brand-ink">{t("History ({n})", { n: past.length })}</summary>
                <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
                  {past.map((h) => (
                    <li key={h.id}>
                      {h.shareholder.name}: {n(h.percent)}% · {d10(h.effectiveFrom)} ~ {d10(h.effectiveTo)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
        );
      })}
    </div>
  );
}

async function Rules({ manage, brands, t }: { manage: boolean; brands: { id: number; name: string }[]; t: T }) {
  const cats = await prisma.expenseCategory.findMany({ orderBy: [{ kind: "asc" }, { sort: "asc" }] });
  const rules = await Promise.all(brands.map(async (b) => ({ b, r: await ruleFor(b.id) })));
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-2">
        {t("Dividend profit = Win/Loss + counted income − counted costs. Each brand can count different costs.")}{" "}
        <Info>{t("These rules only decide how dividends are worked out. The company's net profit everywhere else follows Settings → General.")}</Info>
      </p>
      {rules.map(({ b, r }) => (
        <Card key={b.id} title={b.name}>
          <ActionForm action={saveRule} className="space-y-4">
            <input type="hidden" name="brandId" value={b.id} />
            <div className="grid gap-4 md:grid-cols-3">
              <Field label={t("Settle")}>
                <select name="period" className="input" defaultValue={r.period} disabled={!manage}>
                  <option value="MONTHLY">{t("Every month")}</option>
                  <option value="QUARTERLY">{t("Every quarter")}</option>
                </select>
              </Field>
              <Field label={t("Company keeps first (%)")} hint={t("Reserve or management fee, taken before splitting")}>
                <input name="reservePercent" className="input" inputMode="decimal" defaultValue={r.reservePercent} disabled={!manage} />
              </Field>
              <label className="flex items-start gap-2 pt-6 text-sm">
                <input type="checkbox" name="carryLoss" defaultChecked={r.carryLoss} disabled={!manage} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
                <span>
                  {t("Carry losses forward")}
                  <span className="block text-xs text-muted">{t("A losing period is taken off the next profitable one before anything is paid out.")}</span>
                </span>
              </label>
            </div>
            <fieldset>
              <legend className="label">{t("Deduct before splitting")}</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="deductFees" defaultChecked={r.deductFees} disabled={!manage} className="h-4 w-4 accent-[var(--brand)]" /> {t("PG / bank fees")}
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="deductPromos" defaultChecked={r.deductPromos} disabled={!manage} className="h-4 w-4 accent-[var(--brand)]" /> {t("Promotions")}
                </label>
              </div>
            </fieldset>
            <fieldset>
              <legend className="label">{t("Leave these categories out of dividend profit")}</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                {cats.map((c) => (
                  <label key={c.id} className="flex items-center gap-2">
                    <input type="checkbox" name="excluded" value={c.id} defaultChecked={r.excludedCategoryIds.includes(c.id)} disabled={!manage} className="h-4 w-4 accent-[var(--brand)]" />
                    {t(c.name)} <span className="text-xs text-muted">({c.kind === "INCOME" ? t("income") : t("expense")})</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {manage && <Submit>{t("Save rules for {name}", { name: b.name })}</Submit>}
          </ActionForm>
        </Card>
      ))}
    </div>
  );
}

async function Holders({ manage, t }: { manage: boolean; t: T }) {
  const list = await prisma.shareholder.findMany({ include: { holdings: { where: { effectiveTo: null }, include: { brand: true } } }, orderBy: [{ active: "desc" }, { name: "asc" }] });
  const form = (s?: (typeof list)[number]) => (
    <ActionForm action={saveShareholder} close className="space-y-3">
      {s && <input type="hidden" name="id" value={s.id} />}
      <Field label={t("Name")}>
        <input name="name" className="input" defaultValue={s?.name} required />
      </Field>
      <Field label={t("Phone")}>
        <input name="phone" className="input" defaultValue={s?.phone ?? ""} />
      </Field>
      <Field label={t("Note")} hint={t("e.g. bank account for payments")}>
        <input name="note" className="input" defaultValue={s?.note ?? ""} />
      </Field>
      <div className="flex justify-end">
        <Submit>{t("Save")}</Submit>
      </div>
    </ActionForm>
  );
  return (
    <Card
      flush
      title={t("Shareholders")}
      action={
        manage && (
          <Dialog label={"+ " + t("Add shareholder")} title={t("Add shareholder")} className="btn btn-primary btn-sm">
            {form()}
          </Dialog>
        )
      }
    >
      {list.length === 0 ? (
        <Empty title={t("No shareholders yet")} />
      ) : (
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("Name")}</th>
                <th>{t("Current shares")}</th>
                <th>{t("Contact / note")}</th>
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className={s.active ? "" : "opacity-60"}>
                  <td className="font-medium">{s.name}</td>
                  <td>{s.holdings.length ? s.holdings.map((h) => `${h.brand.name} ${n(h.percent)}%`).join(" · ") : <span className="text-muted">–</span>}</td>
                  <td className="text-ink-2">{[s.phone, s.note].filter(Boolean).join(" · ") || "–"}</td>
                  {manage && (
                    <td className="r space-x-1">
                      <Dialog label={t("Edit")} title={t("Edit {name}", { name: s.name })}>
                        {form(s)}
                      </Dialog>
                      <ActionButton action={toggleShareholder} fields={{ id: s.id }}>
                        {s.active ? t("Deactivate") : t("Reactivate")}
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
  );
}
