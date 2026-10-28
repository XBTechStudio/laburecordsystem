import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, Submit } from "@/components/client";
import { Card, Chip, Empty, Info, Notice, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { dt, money } from "@/lib/format";
import type { T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";
import type { PgLine, SysTxn } from "@/lib/statement-match";
import { accountDays } from "@/lib/statements";
import { clock, DayPicker, pickDay, readAgo, statementStatus } from "../../parts";
import { markStatementChecked, readStatementsNow } from "../../statement-actions";

export default async function StatementAccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("reconcile");
  const id = Number((await params).id);
  const day = pickDay((await searchParams).day);
  const acc = Number.isInteger(id) ? await prisma.payChannel.findUnique({ where: { id } }) : null;
  if (!acc) notFound();
  const [t, settings] = await Promise.all([getT(), getSettings()]);
  const d = (await accountDays(day, [id], settings.statementMinutes)).get(id)!;
  const m = d.match;
  const s = d.statement;
  const cur = acc.currency;
  const canAdd = can(user, "reconcile", 2);
  const st = statementStatus(acc, d);
  const page = acc.statementUrl ? `${acc.statementUrl}${acc.statementUrl.includes("?") ? "&" : "?"}d=${day}` : null;

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <Link href={`/reconcile/statements?day=${day}`} className="text-sm text-ink-2 hover:underline">
            ← {t("Statement match")}
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold">
            {acc.name} <Chip tone={st.tone}>{t(st.label)}</Chip>
          </h1>
          <p className="text-sm text-ink-2">
            {t("Last read {when}", { when: readAgo(s?.readAt ?? null, t) })}
            {page && (
              <>
                {" · "}
                <a href={page} target="_blank" rel="noreferrer" className="link">
                  {t("Open the statement page")} ↗
                </a>
              </>
            )}
            {" · "}
            <Link href={`/reconcile/${acc.id}`} className="link">
              {t("Balance and settings")}
            </Link>
          </p>
          {acc.statementError && <p className="mt-1 text-sm text-critical-ink">⚠ {t(acc.statementError)}</p>}
        </div>
        <DayPicker path={`/reconcile/statements/${acc.id}`} day={day} t={t} />
        {canAdd && acc.statementUrl && (
          <ActionForm action={readStatementsNow}>
            <input type="hidden" name="day" value={day} />
            <input type="hidden" name="channelId" value={acc.id} />
            <Submit className="btn btn-sm h-8" pending={t("Reading…")}>
              ↻ {t("Read now")}
            </Submit>
          </ActionForm>
        )}
      </div>

      {!acc.statementUrl ? (
        <Card>
          <Empty title={t("This account has no statement link")}>
            <Link href={`/reconcile/${acc.id}`} className="link">
              {t("Add it in Account settings")}
            </Link>
          </Empty>
        </Card>
      ) : !s || !m ? (
        <Card>
          <Empty title={t("This day hasn't been read yet")}>{t("Press “Read now” to read it.")}</Empty>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Compare
              label={t("Deposits")}
              statement={s.totalIn}
              statementCount={m.pairs.filter((p) => p.pg.k === "IN").length + m.pgOnly.filter((l) => l.k === "IN").length}
              system={d.system.dep}
              systemCount={d.system.depCount}
              cur={cur}
              t={t}
            />
            <Compare
              label={t("Payouts")}
              statement={s.totalOut}
              statementCount={m.pairs.filter((p) => p.pg.k === "OUT").length + m.pgOnly.filter((l) => l.k === "OUT").length}
              system={d.system.wd}
              systemCount={d.system.wdCount}
              cur={cur}
              t={t}
            />
            <Compare
              label={t("Deposits − payouts")}
              statement={s.totalIn - s.totalOut}
              system={d.system.dep - d.system.wd}
              cur={cur}
              t={t}
              note={s.remaining != null ? t("Statement “remaining”: {v}", { v: money(s.remaining, cur) }) : undefined}
            />
          </div>

          {d.open === 0 ? (
            <Notice tone="good">
              {m.pairs.length
                ? t("Every line on the statement matches a deposit or withdrawal in the system, and nothing in the system is missing from the statement.")
                : t("Nothing on the statement and nothing in the system for this day.")}
            </Notice>
          ) : (
            <div className="grid gap-5 xl:grid-cols-2">
              <PgList
                title={t("Received, but not in the system")}
                hint={t("Money reached the account but no deposit was recorded. Check that the player was credited, or import the latest file.")}
                lines={m.pgOnly.filter((l) => l.k === "IN")}
                cur={cur}
                t={t}
              />
              <SysList
                title={t("In the system, but not received")}
                hint={t("A deposit was recorded but the statement doesn't show the money. Check for a wrong account or a fake receipt.")}
                rows={m.sysOnly.filter((x) => x.type === "DEPOSIT")}
                cur={cur}
                t={t}
              />
              <PgList
                title={t("Paid out, but not in the system")}
                hint={t("Money left the account but no withdrawal was recorded.")}
                lines={m.pgOnly.filter((l) => l.k === "OUT")}
                cur={cur}
                t={t}
              />
              <SysList
                title={t("In the system, but not paid out")}
                hint={t("A withdrawal was recorded but the statement doesn't show the payment.")}
                rows={m.sysOnly.filter((x) => x.type === "WITHDRAW")}
                cur={cur}
                t={t}
              />
            </div>
          )}

          {d.open > 0 && (
            <Card title={t("Checked")}>
              {s.checkedBy ? (
                <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
                  <div>
                    <div>
                      ✓ {s.checkedBy} · {dt(s.checkedAt)}
                    </div>
                    {s.note && <div className="mt-1 text-ink-2">{s.note}</div>}
                  </div>
                  {canAdd && (
                    <ActionForm action={markStatementChecked}>
                      <input type="hidden" name="day" value={day} />
                      <input type="hidden" name="channelId" value={acc.id} />
                      <input type="hidden" name="undo" value="1" />
                      <Submit className="btn btn-sm">{t("Open again")}</Submit>
                    </ActionForm>
                  )}
                </div>
              ) : canAdd ? (
                <ActionForm action={markStatementChecked} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="day" value={day} />
                  <input type="hidden" name="channelId" value={acc.id} />
                  <input name="note" className="input min-w-64 flex-1" maxLength={250} placeholder={t("What you found, e.g. “CDM 50 is player ali01, credited by hand”")} />
                  <Submit>{t("Mark as checked")}</Submit>
                </ActionForm>
              ) : (
                <p className="text-sm text-ink-2">{t("Not checked yet.")}</p>
              )}
            </Card>
          )}

          {m.pairs.length > 0 && (
            <Card flush>
              <details>
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
                  {t("Matched lines ({n})", { n: m.pairs.length })}
                  {m.pairs.some((p) => p.late) && <span className="ml-2 font-normal text-warning-ink">{t("{n} far apart in time", { n: m.pairs.filter((p) => p.late).length })}</span>}
                </summary>
                <TableWrap>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t("Statement")}</th>
                        <th>{t("Name")}</th>
                        <th className="r">{t("Amount")}</th>
                        <th>{t("System")}</th>
                        <th>{t("Player")}</th>
                        <th>{t("Entered by")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.pairs.map((p) => (
                        <tr key={`${p.pg.i}-${p.sys.id}`}>
                          <td className="whitespace-nowrap text-ink-2">
                            {p.pg.k === "IN" ? "＋" : "－"} {p.pg.t}
                          </td>
                          <td>
                            {p.pg.name}
                            {p.sameName && <span className="ml-1 text-good-ink">✓</span>}
                          </td>
                          <td className="r">{money(p.pg.amount, cur)}</td>
                          <td className={`whitespace-nowrap ${p.late ? "text-warning-ink" : "text-ink-2"}`}>
                            {clock(p.sys.at)} <span className="text-xs">({minutesApart(p.minutes, t)})</span>
                          </td>
                          <td>
                            <Link className="hover:underline" href={`/players/${p.sys.playerId}`}>
                              {p.sys.username}
                            </Link>
                            {p.sys.name && <span className="text-xs text-muted"> · {p.sys.name}</span>}
                          </td>
                          <td className="text-ink-2">{p.sys.enteredBy ?? "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </details>
            </Card>
          )}

          {m.reversed.length > 0 && (
            <Card title={t("Reversed on the statement")} note={t("A payment and its reversal cancel each other, so neither needs a match.")}>
              <ul className="space-y-1 text-sm">
                {m.reversed.map((l) => (
                  <li key={l.i} className="flex justify-between gap-3 tabular-nums">
                    <span className="text-ink-2">
                      {l.t} · {l.name}
                    </span>
                    <span>{money(l.amount, cur)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <p className="text-xs text-muted">
            {t("A line and a recorded entry are paired when the amount is exactly equal and the times are no more than {n} minutes apart (Settings → Promotions & reconciliation).", {
              n: settings.statementMinutes,
            })}{" "}
            <Info>{t("Statements only show the first word of the payer's name. When a player's full name is on file, a matching name decides between equal amounts.")}</Info>
          </p>
        </>
      )}
    </div>
  );
}

function minutesApart(minutes: number, t: T) {
  if (minutes < 1) return t("same minute");
  if (minutes < 120) return t("{n} min apart", { n: Math.round(minutes) });
  return t("{n} h apart", { n: Math.round(minutes / 60) });
}

function Compare({ label, statement, statementCount, system, systemCount, cur, t, note }: { label: string; statement: number; statementCount?: number; system: number; systemCount?: number; cur: string; t: T; note?: string }) {
  const diff = Math.round((system - statement) * 100) / 100;
  return (
    <div className="card p-3.5 text-sm">
      <div className="text-xs text-ink-2">{label}</div>
      <div className="mt-1.5 flex justify-between gap-2">
        <span className="text-ink-2">{t("Statement")}</span>
        <span className="font-semibold tabular-nums">
          {money(statement, cur)}
          {statementCount != null && <span className="ml-1 text-xs font-normal text-muted">×{statementCount}</span>}
        </span>
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-ink-2">{t("System")}</span>
        <span className="font-semibold tabular-nums">
          {money(system, cur)}
          {systemCount != null && <span className="ml-1 text-xs font-normal text-muted">×{systemCount}</span>}
        </span>
      </div>
      <div className={`mt-1 flex justify-between gap-2 border-t border-line pt-1 ${diff ? "font-semibold text-critical-ink" : "text-good-ink"}`}>
        <span>{t("Difference")}</span>
        <span className="tabular-nums">{diff ? `${diff > 0 ? "+" : ""}${money(diff, cur)}` : "✓"}</span>
      </div>
      {note && <div className="mt-1 text-xs text-muted">{note}</div>}
    </div>
  );
}

function PgList({ title, hint, lines, cur, t }: { title: string; hint: string; lines: PgLine[]; cur: string; t: T }) {
  if (!lines.length) return null;
  return (
    <Card flush title={`${title} (${lines.length})`} note={money(lines.reduce((a, l) => a + l.amount, 0), cur)}>
      <p className="border-b border-line px-4 pb-2.5 text-xs text-ink-2">{hint}</p>
      <TableWrap>
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("Time")}</th>
              <th>{t("Name on statement")}</th>
              <th className="r">{t("Amount")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.i}>
                <td className="whitespace-nowrap text-ink-2">{l.t}</td>
                <td className="font-medium">{l.name}</td>
                <td className="r font-medium text-critical-ink">{money(l.amount, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

function SysList({ title, hint, rows, cur, t }: { title: string; hint: string; rows: SysTxn[]; cur: string; t: T }) {
  if (!rows.length) return null;
  return (
    <Card flush title={`${title} (${rows.length})`} note={money(rows.reduce((a, x) => a + x.amount, 0), cur)}>
      <p className="border-b border-line px-4 pb-2.5 text-xs text-ink-2">{hint}</p>
      <TableWrap>
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("Time")}</th>
              <th>{t("Player")}</th>
              <th className="r">{t("Amount")}</th>
              <th>{t("Ref")}</th>
              <th>{t("Entered by")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id}>
                <td className="whitespace-nowrap text-ink-2">{clock(x.at)}</td>
                <td>
                  <Link className="font-medium hover:underline" href={`/players/${x.playerId}`}>
                    {x.username}
                  </Link>
                  {x.name && <div className="text-xs text-muted">{x.name}</div>}
                </td>
                <td className="r font-medium text-critical-ink">{money(x.amount, cur)}</td>
                <td className="whitespace-nowrap text-ink-2">{x.ref ?? "–"}</td>
                <td className="whitespace-nowrap text-ink-2">{x.enteredBy ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}
