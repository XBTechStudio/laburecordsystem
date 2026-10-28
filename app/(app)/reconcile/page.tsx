import Link from "next/link";
import { Prisma } from "@prisma/client";
import { ActionForm, AutoSelect, Dialog, Submit } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Chip, Empty, Field, Info, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { addDays, dateRange, dayStart, parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { money, money0, n } from "@/lib/format";
import { dailyRows } from "@/lib/metrics";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { saveReconNote } from "./actions";
import { tk } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";

type Status = { label: string; tone: "good" | "warning" | "critical" | "brand" };

export default async function ReconcilePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("reconcile");
  const sp = await searchParams;
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const range = parseRange(sp, "week");
  const ids = scope.brandIds;
  const tol = settings.reconTolerance;
  const manage = can(user, "reconcile", 3);
  const onlyProblems = sp.show !== "all";

  const [days, flows, notes, byChannel] = await Promise.all([
    dailyRows(ids, range),
    ids.length ? prisma.channelFlow.findMany({ where: { brandId: { in: ids }, date: dateRange(range) }, include: { channel: true } }) : Promise.resolve([]),
    ids.length ? prisma.reconNote.findMany({ where: { brandId: { in: ids }, date: dateRange(range) } }) : Promise.resolve([]),
    ids.length
      ? prisma.$queryRaw<{ brandId: number; d: string; channelId: number | null; type: string; amt: unknown; cnt: bigint }[]>`
          SELECT brandId, DATE_FORMAT(DATE_ADD(txnAt, INTERVAL 8 HOUR), '%Y-%m-%d') AS d, channelId, type, SUM(amount) AS amt, COUNT(*) AS cnt
          FROM \`Txn\` WHERE brandId IN (${Prisma.join(ids)}) AND txnAt >= ${dayStart(range.from)} AND txnAt < ${dayStart(addDays(range.to, 1))}
          GROUP BY brandId, d, channelId, type`
      : Promise.resolve([]),
  ]);
  const key = (b: number, d: string) => `${b}|${d}`;
  const hasStatement = new Set(flows.map((f) => key(f.brandId, f.date.toISOString().slice(0, 10))));
  const noteOf = new Map(notes.map((x) => [key(x.brandId, x.date.toISOString().slice(0, 10)), x]));
  const channelNames = new Map(flows.map((f) => [f.channelId, f.channel.name]));
  for (const c of await prisma.payChannel.findMany({ select: { id: true, name: true } })) channelNames.set(c.id, c.name);

  const rows = days
    .filter((d) => d.depositCount + d.withdrawCount > 0 || hasStatement.has(key(d.brandId, d.day)))
    .map((d) => {
      const k = key(d.brandId, d.day);
      const stmt = hasStatement.has(k);
      const bo = d.depositCount + d.withdrawCount > 0;
      const diffIn = d.flowIn - d.deposit;
      const diffOut = d.flowOut - d.withdraw;
      const status: Status = !stmt
        ? { label: tk("No statement"), tone: "warning" }
        : !bo
          ? { label: tk("No back-office data"), tone: "warning" }
          : Math.abs(diffIn) <= tol && Math.abs(diffOut) <= tol
            ? { label: tk("Matched"), tone: "good" }
            : { label: tk("Difference"), tone: "critical" };
      const note = noteOf.get(k);
      return { d, k, stmt, diffIn, diffOut, status, note, problem: status.tone !== "good" && !note?.resolved };
    })
    .sort((a, b) => (a.d.day === b.d.day ? a.d.brandId - b.d.brandId : a.d.day < b.d.day ? 1 : -1));
  const shown = onlyProblems ? rows.filter((r) => r.problem) : rows;
  const unexplained = rows.filter((r) => r.problem && r.status.label === "Difference").reduce((a, r) => a + (Math.abs(r.diffIn) + Math.abs(r.diffOut)) * scope.rate(r.d.brandId), 0);

  // Per-channel detail, for the expandable breakdown.
  const detail = new Map<string, Map<number | null, { boIn: number; boOut: number; stIn: number; stOut: number }>>();
  const cell = (k: string, ch: number | null) => {
    const m = detail.get(k) ?? new Map();
    detail.set(k, m);
    const v = m.get(ch) ?? { boIn: 0, boOut: 0, stIn: 0, stOut: 0 };
    m.set(ch, v);
    return v;
  };
  for (const t of byChannel) {
    const v = cell(key(t.brandId, t.d), t.channelId);
    if (t.type === "DEPOSIT") v.boIn += n(t.amt as number);
    else v.boOut += n(t.amt as number);
  }
  for (const f of flows) {
    const v = cell(key(f.brandId, f.date.toISOString().slice(0, 10)), f.channelId);
    v.stIn += n(f.inAmount);
    v.stOut += n(f.outAmount);
  }
  const multi = !scope.current;

  return (
    <div className="max-w-[1400px]">
      <PageHeader
        title={t("PG / bank reconciliation")}
        desc={
          <>
            {t("Back-office deposits and withdrawals against what the PG and bank statements say, day by day.")}{" "}
            <Info>
              {t("Back office = the deposits and withdrawals entered or imported. Statement = the daily PG/bank figures entered under Data entry → PG & bank statements. Differences up to {tol} are treated as matched (Settings → Promotions & reconciliation).", { tol })}
            </Info>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RangeBar path="/reconcile" range={range} params={sp} />
        <form action="/reconcile">
          {Object.entries(sp)
            .filter(([k, v]) => v && k !== "show")
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <AutoSelect name="show" defaultValue={onlyProblems ? "" : "all"} className="input h-8 w-auto">
            <option value="">{t("Only days that need checking")}</option>
            <option value="all">{t("All days")}</option>
          </AutoSelect>
        </form>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={t("Days compared")} value={String(rows.length)} />
        <Tile label={t("Matched")} value={String(rows.filter((r) => r.status.tone === "good").length)} tone="good" />
        <Tile label={t("Need checking")} value={String(rows.filter((r) => r.problem).length)} tone={rows.some((r) => r.problem) ? "critical" : undefined} />
        <Tile label={t("Unexplained difference")} value={money0(unexplained, scope.currency)} tone={unexplained > 0 ? "critical" : undefined} />
      </div>

      <Card flush>
        {shown.length === 0 ? (
          <Empty title={rows.length ? t("Everything matches") : t("Nothing to compare yet")}>
            {rows.length ? (
              t("No days need checking in this period.")
            ) : (
              <>
                {t("Enter PG/bank statements under Data entry to start comparing.")}{" "}
                <Link className="link" href="/entry?kind=flow">
                  {t("Data entry")} →
                </Link>
              </>
            )}
          </Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Date")}</th>
                  {multi && <th>{t("Brand")}</th>}
                  <th className="r">{t("Back-office deposits")}</th>
                  <th className="r">{t("Statement in")}</th>
                  <th className="r">{t("Difference")}</th>
                  <th className="r">{t("Back-office withdrawals")}</th>
                  <th className="r">{t("Statement out")}</th>
                  <th className="r">{t("Difference")}</th>
                  <th>{t("Status")}</th>
                  <th>{t("Note")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ d, k, diffIn, diffOut, status, note }) => {
                  const cur = scope.brandCurrency(d.brandId);
                  const chans = [...(detail.get(k)?.entries() ?? [])];
                  return (
                    <tr key={k} className="align-top">
                      <td className="whitespace-nowrap">
                        <div className="font-medium">{d.day}</div>
                        {chans.length > 1 && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-brand-ink">{t("By PG / bank")}</summary>
                            <table className="mt-1 text-xs">
                              <tbody>
                                {chans.map(([ch, v]) => (
                                  <tr key={String(ch)}>
                                    <td className="pr-3 text-ink-2">{ch == null ? t("No PG/bank set") : channelNames.get(ch)}</td>
                                    <td className="pr-3 text-right tabular-nums">
                                      {t("in")} {money0(v.boIn, cur)} / {money0(v.stIn, cur)}
                                    </td>
                                    <td className="text-right tabular-nums">
                                      {t("out")} {money0(v.boOut, cur)} / {money0(v.stOut, cur)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </details>
                        )}
                      </td>
                      {multi && <td className="text-ink-2">{scope.brandName(d.brandId)}</td>}
                      <td className="r">
                        {money(d.deposit, cur)} <span className="text-xs text-muted">×{d.depositCount}</span>
                      </td>
                      <td className="r">
                        {money(d.flowIn, cur)} <span className="text-xs text-muted">×{d.flowInCount}</span>
                      </td>
                      <Diff v={diffIn} tol={tol} cur={cur} />
                      <td className="r">
                        {money(d.withdraw, cur)} <span className="text-xs text-muted">×{d.withdrawCount}</span>
                      </td>
                      <td className="r">
                        {money(d.flowOut, cur)} <span className="text-xs text-muted">×{d.flowOutCount}</span>
                      </td>
                      <Diff v={diffOut} tol={tol} cur={cur} />
                      <td>
                        {note?.resolved ? (
                          <Chip tone="brand" title={t("Was: {status}", { status: t(status.label) })}>
                            ✓ {t("Checked")}
                          </Chip>
                        ) : (
                          <Chip tone={status.tone}>{t(status.label)}</Chip>
                        )}
                      </td>
                      <td className="min-w-52">
                        {note?.note && (
                          <div className="text-xs">
                            {note.note}
                            <div className="text-muted">— {note.userName}</div>
                          </div>
                        )}
                        {manage && (
                          <Dialog label={note ? t("Edit note") : t("Add note")} title={`${scope.brandName(d.brandId)} · ${d.day}`} className="btn btn-sm mt-1">
                            <ActionForm action={saveReconNote} close className="space-y-3">
                              <input type="hidden" name="brandId" value={d.brandId} />
                              <input type="hidden" name="date" value={d.day} />
                              <Field label={t("What explains the difference?")}>
                                <textarea name="note" rows={3} className="input" defaultValue={note?.note ?? ""} placeholder={t("e.g. PG settled 2 deposits the next day")} />
                              </Field>
                              <label className="flex items-center gap-2 text-sm">
                                <input type="checkbox" name="resolved" defaultChecked={note?.resolved ?? true} className="h-4 w-4 accent-[var(--brand)]" /> {t("Mark this day as checked")}
                              </label>
                              <div className="flex justify-end">
                                <Submit>{t("Save")}</Submit>
                              </div>
                            </ActionForm>
                          </Dialog>
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
    </div>
  );
}

function Diff({ v, tol, cur }: { v: number; tol: number; cur: string }) {
  const off = Math.abs(v) > tol;
  return (
    <td className={`r font-medium ${off ? "text-critical-ink" : "text-muted"}`}>
      {off ? (v > 0 ? "+" : "−") + money(Math.abs(v), cur).replace(/^\S+ /, "") : "–"}
    </td>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "good" | "critical" }) {
  return (
    <div className="card p-3.5">
      <div className="text-xs text-ink-2">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone === "critical" ? "text-critical-ink" : tone === "good" ? "text-good-ink" : ""}`}>{value}</div>
    </div>
  );
}
