import Link from "next/link";
import { ActionButton, ActionForm, AutoSelect, Dialog, Submit } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Empty, Field, Info, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { count, money0, pct } from "@/lib/format";
import type { T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { buildReport, GROUPS, METRICS, parseCols, type Group } from "@/lib/report";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { deleteReport, saveReport } from "./actions";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePage("reports");
  const raw = await searchParams;
  // The column picker sends each ticked box as ?c=…; saved links use ?cols=a,b,c.
  const ticked = [raw.c].flat().filter(Boolean).join(",");
  const sp = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v])) as Record<string, string | undefined>;
  if (ticked) sp.cols = ticked;
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const range = parseRange(sp, "month");
  const group = (GROUPS.find((g) => g.key === sp.group)?.key ?? (scope.current ? "day" : "brand")) as Group;
  const cols = parseCols(sp.cols);
  const metrics = METRICS.filter((m) => cols.includes(m.key));
  const [report, saved] = await Promise.all([
    buildReport(scope, settings, range, group, t),
    prisma.savedReport.findMany({ where: { OR: [{ ownerId: user.id }, { shared: true }] }, orderBy: { name: "asc" } }),
  ]);
  const cur = scope.currency;
  const qs = new URLSearchParams({ group, cols: cols.join(","), ...(range.preset ? { preset: range.preset } : { from: range.from, to: range.to }) });
  const savedHref = (c: Record<string, string | null>) => `/reports?${new URLSearchParams(Object.entries(c).filter(([, v]) => v) as [string, string][])}`;
  const fmt = (kind: string, v: number) => (kind === "money" ? money0(v, cur) : kind === "pct" ? pct(v) : count(v));
  const empty = report.total.depositCount + report.total.withdrawCount + report.total.expense + report.total.fees + report.total.promo === 0;
  const rangeFields = range.preset ? (
    <input type="hidden" name="preset" value={range.preset} />
  ) : (
    <>
      <input type="hidden" name="from" value={range.from} />
      <input type="hidden" name="to" value={range.to} />
    </>
  );

  return (
    <div className="max-w-[1400px]">
      <PageHeader
        title={t("Reports")}
        desc={`${scope.current ? scope.current.name : t("All brands")} · ${range.from} ~ ${range.to}${scope.current ? "" : ` · ${cur}`}`}
        actions={
          <>
            <Dialog label={t("Save as…")} title={t("Save this report")}>
              <ActionForm action={saveReport} close className="space-y-3">
                <input type="hidden" name="group" value={group} />
                <input type="hidden" name="cols" value={cols.join(",")} />
                <input type="hidden" name="preset" value={range.preset ?? ""} />
                {!range.preset && (
                  <>
                    <input type="hidden" name="from" value={range.from} />
                    <input type="hidden" name="to" value={range.to} />
                  </>
                )}
                <Field label={t("Name")} hint={range.preset ? t("The date range moves with time (e.g. always “this month”).") : t("Keeps the exact dates you picked.")}>
                  <input name="name" className="input" required placeholder={t("e.g. Monthly profit by brand")} />
                </Field>
                {can(user, "reports", 3) && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="shared" defaultChecked className="h-4 w-4 accent-[var(--brand)]" /> {t("Share with the team")}
                  </label>
                )}
                <div className="flex justify-end">
                  <Submit>{t("Save report")}</Submit>
                </div>
              </ActionForm>
            </Dialog>
            <a className="btn btn-primary" href={`/api/export/report?${qs}`}>
              ⬇ {t("Export Excel")}
            </a>
          </>
        }
      />

      {saved.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">{t("Saved:")}</span>
          {saved.map((r) => {
            const c = r.config as Record<string, string | null>;
            return (
              <span key={r.id} className="inline-flex items-center rounded-lg border border-line bg-surface text-sm">
                <Link href={savedHref(c)} className="px-2.5 py-1 hover:text-brand-ink">
                  {r.name}
                  {!r.shared && <span className="ml-1 text-xs text-muted">({t("only me")})</span>}
                </Link>
                {(r.ownerId === user.id || can(user, "reports", 3)) && (
                  <ActionButton
                    action={deleteReport}
                    fields={{ id: r.id }}
                    question={t("Delete the saved report “{name}”?", { name: r.name })}
                    className="border-l border-line px-1.5 py-1 text-xs text-muted hover:text-critical-ink"
                  >
                    ✕
                  </ActionButton>
                )}
              </span>
            );
          })}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RangeBar path="/reports" range={range} params={{ group, cols: cols.join(",") }} />
        <form action="/reports" className="flex items-center gap-2">
          {rangeFields}
          <input type="hidden" name="cols" value={cols.join(",")} />
          <AutoSelect name="group" defaultValue={group} className="input h-8 w-auto">
            {GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {t(g.label)}
              </option>
            ))}
          </AutoSelect>
        </form>
        <details className="relative">
          <summary className="btn btn-sm h-8 list-none">{t("Columns ({n})", { n: cols.length })} ▾</summary>
          <form action="/reports" className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-line bg-surface p-3 shadow-lg sm:right-auto sm:left-0">
            {rangeFields}
            <input type="hidden" name="group" value={group} />
            <ColumnPicker selected={cols} t={t} />
          </form>
        </details>
      </div>

      <Card flush>
        {empty ? (
          <Empty title={t("No data in this period")}>{t("Enter or import deposits, withdrawals, statements or expenses, and they'll show up here.")}</Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t(GROUPS.find((g) => g.key === group)!.col)}</th>
                  {metrics.map((m) => (
                    <th key={m.key} className="r">
                      {t(m.label)} <Info>{t(m.explain)}</Info>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.lines.map((l) => (
                  <tr key={l.key}>
                    <td className="font-medium whitespace-nowrap">{l.label}</td>
                    {metrics.map((m) => {
                      const v = m.get(l.t);
                      return (
                        <td key={m.key} className={`r ${(m.key === "profit" || m.key === "winlose" || m.key === "margin") && v < 0 ? "text-critical-ink" : ""} ${v === 0 ? "text-muted" : ""}`}>
                          {fmt(m.kind, v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{t("Total")}</td>
                  {metrics.map((m) => {
                    const v = m.get(report.total);
                    return (
                      <td key={m.key} className={`r ${(m.key === "profit" || m.key === "winlose") && v < 0 ? "text-critical-ink" : ""}`}>
                        {fmt(m.kind, v)}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

/** Checkbox list; each ticked box is sent as ?c=… and the page joins them. */
function ColumnPicker({ selected, t }: { selected: string[]; t: T }) {
  return (
    <>
      <div className="mb-2 text-xs font-medium text-ink-2">{t("Show these columns")}</div>
      <div className="max-h-80 space-y-1.5 overflow-y-auto">
        {METRICS.map((m) => (
          <label key={m.key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="c" value={m.key} defaultChecked={selected.includes(m.key)} className="h-4 w-4 accent-[var(--brand)]" />
            {t(m.label)}
          </label>
        ))}
      </div>
      <button className="btn btn-primary btn-sm mt-3 w-full">{t("Apply")}</button>
    </>
  );
}
