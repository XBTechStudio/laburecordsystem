import Link from "next/link";
import { ActionForm, Submit } from "@/components/client";
import { Card, Chip, Empty, Info, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { money } from "@/lib/format";
import type { T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";
import { accountDays } from "@/lib/statements";
import { DayPicker, pickDay, readAgo, ReconcileTabs, statementStatus } from "../parts";
import { readStatementsNow } from "../statement-actions";

export default async function StatementsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("reconcile");
  const day = pickDay((await searchParams).day);
  const [t, settings] = await Promise.all([getT(), getSettings()]);
  const [accounts, unlinked] = await Promise.all([
    prisma.payChannel.findMany({ where: { active: true, statementUrl: { not: null } }, orderBy: [{ type: "asc" }, { name: "asc" }] }),
    prisma.payChannel.count({ where: { active: true, statementUrl: null } }),
  ]);
  const days = await accountDays(
    day,
    accounts.map((a) => a.id),
    settings.statementMinutes,
  );
  const canRead = can(user, "reconcile", 2);
  const toLook = accounts.filter((a) => {
    const d = days.get(a.id);
    return d && d.open > 0 && !d.statement?.checkedBy;
  }).length;

  return (
    <div className="max-w-[1400px] space-y-5">
      <div>
        <PageHeader
          title={t("PG / bank reconciliation")}
          desc={
            <>
              {t("Each account's own statement page, matched line by line with the deposits and withdrawals in the system.")}{" "}
              <Info>
                {t(
                  "The system reads each linked statement page every 15 minutes. A line and a recorded deposit or withdrawal count as the same when the amount is exactly equal and the times are no more than {n} minutes apart; when amounts are equal, a matching name decides. Entries typed in or imported later are matched straight away.",
                  { n: settings.statementMinutes },
                )}
              </Info>
            </>
          }
        />
        <ReconcileTabs active="statements" t={t} />
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <DayPicker path="/reconcile/statements" day={day} t={t} />
        {canRead && accounts.length > 0 && (
          <ActionForm action={readStatementsNow} className="text-right">
            <input type="hidden" name="day" value={day} />
            <Submit className="btn btn-sm h-8" pending={t("Reading…")}>
              ↻ {t("Read now")}
            </Submit>
          </ActionForm>
        )}
      </div>

      {accounts.length === 0 ? (
        <Card>
          <Empty title={t("No account has a statement link yet")}>
            {t("Open an account under Balances, paste the link of its statement page in Account settings and save. The system reads it from then on.")}
          </Empty>
        </Card>
      ) : (
        <Card
          flush
          title={toLook ? t("{n} accounts don't match", { n: toLook }) : t("{n} accounts", { n: accounts.length })}
          note={unlinked ? t("{n} accounts have no statement link", { n: unlinked }) : undefined}
        >
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Account")}</th>
                  <th className="r">
                    {t("Deposits")}
                    <div className="text-[11px] font-normal text-muted">{t("statement / system")}</div>
                  </th>
                  <th className="r">
                    {t("Payouts")}
                    <div className="text-[11px] font-normal text-muted">{t("statement / system")}</div>
                  </th>
                  <th>{t("To look at")}</th>
                  <th>{t("Status")}</th>
                  <th>{t("Last read")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const d = days.get(a.id)!;
                  const st = statementStatus(a, d);
                  const m = d.match;
                  const cur = a.currency;
                  return (
                    <tr key={a.id}>
                      <td>
                        <Link href={`/reconcile/statements/${a.id}?day=${day}`} className="font-medium hover:underline">
                          {a.name}
                        </Link>
                        <div className="text-xs text-muted">
                          {a.type === "PG" ? t("Payment gateway") : t("Bank")} · {cur}
                        </div>
                      </td>
                      <td className="r text-xs whitespace-nowrap">
                        {d.statement ? <Pair statement={d.statement.totalIn} system={d.system.dep} count={d.system.depCount} cur={cur} t={t} /> : <span className="text-muted">–</span>}
                      </td>
                      <td className="r text-xs whitespace-nowrap">
                        {d.statement ? <Pair statement={d.statement.totalOut} system={d.system.wd} count={d.system.wdCount} cur={cur} t={t} /> : <span className="text-muted">–</span>}
                      </td>
                      <td className="text-xs">
                        {m && d.open > 0 ? (
                          <>
                            {m.pgOnly.length > 0 && <div>{t("{n} on the statement only", { n: m.pgOnly.length })}</div>}
                            {m.sysOnly.length > 0 && <div>{t("{n} in the system only", { n: m.sysOnly.length })}</div>}
                          </>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td>
                        <Chip tone={st.tone}>{t(st.label)}</Chip>
                        {d.statement?.checkedBy && d.open > 0 && <div className="mt-0.5 text-xs text-muted">{d.statement.checkedBy}</div>}
                      </td>
                      <td className="text-xs whitespace-nowrap">
                        <div className="text-ink-2">{readAgo(d.statement?.readAt ?? null, t)}</div>
                        {a.statementError && (
                          <div className="max-w-56 truncate text-critical-ink" title={t(a.statementError)}>
                            {t(a.statementError)}
                          </div>
                        )}
                      </td>
                      <td className="r">
                        <Link href={`/reconcile/statements/${a.id}?day=${day}`} className="btn btn-sm">
                          {t("Details")}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </div>
  );
}

/** Statement total over the system's, with the difference when there is one. */
function Pair({ statement, system, count, cur, t }: { statement: number; system: number; count: number; cur: string; t: T }) {
  const diff = Math.round((system - statement) * 100) / 100;
  return (
    <>
      <div title={t("On the statement")}>{money(statement, cur)}</div>
      <div className="text-muted" title={t("In the system")}>
        {money(system, cur)} ×{count}
      </div>
      {diff !== 0 && (
        <div className="font-medium text-critical-ink">
          {diff > 0 ? "+" : ""}
          {money(diff, cur)}
        </div>
      )}
    </>
  );
}
