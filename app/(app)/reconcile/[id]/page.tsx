import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, Dialog, Submit } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Field, Info, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { expectedBalances, ledger } from "@/lib/balances";
import { addDays, dayStart, parseRange, todayStr, toLocalInput } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { count, dt, money, n } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";
import { setOpening } from "../actions";
import { MOVE_LABEL, moveDetail } from "@/lib/move-kinds";
import { ExchangeForm } from "../exchange-form";
import { BalanceForm, MoveForm } from "../forms";

export default async function AccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("reconcile");
  const id = Number((await params).id);
  const sp = await searchParams;
  const acc = Number.isInteger(id) ? await prisma.payChannel.findUnique({ where: { id } }) : null;
  if (!acc) notFound();
  const [t, settings] = await Promise.all([getT(), getSettings()]);
  const range = parseRange(sp, "week");
  const cur = acc.currency;
  const canAdd = can(user, "reconcile", 2);
  const full = can(user, "reconcile", 3);
  const [now, days, checks, moves, accounts] = await Promise.all([
    expectedBalances(new Date(), [id]).then((m) => m.get(id)),
    ledger(id, range),
    prisma.balanceCheck.findMany({ where: { channelId: id }, orderBy: { at: "desc" }, take: 20 }),
    prisma.channelMove.findMany({ where: { channelId: id }, orderBy: { at: "desc" }, take: 20 }),
    prisma.payChannel.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, currency: true } }),
  ]);
  const [settleFees, changers] = await Promise.all([
    prisma.channelMove.aggregate({ where: { channelId: id, kind: "SETTLE_FEE", at: { gte: dayStart(range.from), lt: dayStart(addDays(range.to, 1)) } }, _sum: { amount: true }, _count: true }),
    prisma.channelMove.findMany({ where: { kind: { in: ["EXCHANGE_OUT", "EXCHANGE_IN"] }, party: { not: null } }, distinct: ["party"], select: { party: true } }),
  ]);
  const checkByDay = new Map<string, (typeof checks)[number]>();
  for (const c of checks) {
    const d = new Date(c.at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
    if (!checkByDay.has(d)) checkByDay.set(d, c);
  }

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <Link href="/reconcile" className="text-sm text-ink-2 hover:underline">
            ← {t("PG / bank reconciliation")}
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{acc.name}</h1>
          <p className="text-sm text-ink-2">
            {acc.type === "PG" ? t("Payment gateway") : t("Bank")} · {cur} · {t("fee")} {n(acc.feePercent)}% + {n(acc.feeFixed).toFixed(2)}
          </p>
          {settleFees._count > 0 && (
            <p className="text-sm text-ink-2">
              {t("Settlement fees {from} – {to}: {amount} ({n} times)", { from: range.from, to: range.to, amount: money(Math.abs(n(settleFees._sum.amount)), cur), n: settleFees._count })}
            </p>
          )}
        </div>
        <div className="text-right">
          <div className="text-xs text-ink-2">{t("System balance now")}</div>
          <div className="text-2xl font-semibold">{money(now?.expected ?? 0, cur)}</div>
        </div>
        {canAdd && (
          <div className="flex gap-2">
            {acc.statementUrl && (
              <Link href={`/reconcile/statements/${acc.id}`} className="btn">
                {t("Statement match")}
              </Link>
            )}
            <Dialog label={t("Enter balance")} title={t("Real balance of {name}", { name: acc.name })} className="btn btn-primary">
              <BalanceForm acc={{ id: acc.id, name: acc.name, currency: cur }} t={t} today={days.find((d) => d.day === range.to) && range.to === todayStr() ? days.find((d) => d.day === range.to) : undefined} />
            </Dialog>
            <Dialog label={"+ " + t("Money changer")} title={t("Sell to or buy from a money changer")}>
              <ExchangeForm accounts={accounts} channelId={acc.id} parties={changers.map((c) => c.party!)} />
            </Dialog>
            <Dialog label={"+ " + t("Other movement")} title={t("Money in or out of an account")}>
              <MoveForm accounts={accounts} t={t} allowAdjust={full} channelId={acc.id} />
            </Dialog>
          </div>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card
          title={t("How the system balance is made up")}
          action={<Info>{t("Everything is counted from the starting balance onwards. Change the starting point on the right if you begin tracking on a new date.")}</Info>}
        >
          <dl className="space-y-1.5 text-sm">
            {[
              [t("Starting balance"), now?.opening ?? 0, ""],
              [t("Deposits received"), now?.deposits ?? 0, "+"],
              [t("Withdrawals paid"), -(now?.withdrawals ?? 0), "−"],
              [acc.feeAtSettlement ? t("Fees (taken at settlement)") : t("Fees (fee rate × deposits)"), -(now?.fees ?? 0), "−"],
              [t("Transfers and other movements"), now?.moves ?? 0, "±"],
            ].map(([l, v, s]) => (
              <div key={String(l)} className="flex justify-between border-b border-line pb-1.5">
                <dt className="text-ink-2">
                  <span className="inline-block w-4 text-muted">{s}</span>
                  {l}
                </dt>
                <dd className={`tabular-nums ${Number(v) < 0 ? "text-critical-ink" : ""}`}>{money(Math.abs(Number(v)), cur)}</dd>
              </div>
            ))}
            <div className="flex justify-between pt-1 font-semibold">
              <dt>{t("System balance now")}</dt>
              <dd className="tabular-nums">{money(now?.expected ?? 0, cur)}</dd>
            </div>
          </dl>
        </Card>
        <Card title={t("Account settings")} note={acc.openingAt ? t("tracking since {date}", { date: dt(acc.openingAt) }) : t("tracking from the first transaction")}>
          {full ? (
            <ActionForm action={setOpening} className="space-y-3">
              <input type="hidden" name="channelId" value={acc.id} />
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("Type")}>
                  <select name="type" className="input" defaultValue={acc.type}>
                    <option value="PG">{t("Payment gateway")}</option>
                    <option value="BANK">{t("Bank account")}</option>
                  </select>
                </Field>
                <Field label={t("Currency")}>
                  <input name="currency" className="input uppercase" defaultValue={acc.currency} maxLength={5} />
                </Field>
                <Field label={t("Fee %")} hint={t("Of each deposit")}>
                  <input name="feePercent" className="input" inputMode="decimal" defaultValue={n(acc.feePercent)} />
                </Field>
                <Field label={t("Fixed fee per deposit")}>
                  <input name="feeFixed" className="input" inputMode="decimal" defaultValue={n(acc.feeFixed)} />
                </Field>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="feeAtSettlement" defaultChecked={acc.feeAtSettlement} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
                <span>
                  {t("Fee is taken when the PG pays out")}
                  <span className="block text-xs text-muted">{t("Tick this if the PG balance goes up by the full deposit. Record the fee in “Transfer / settlement fee” when you record the settlement.")}</span>
                </span>
              </label>
              <Field label={t("Starting balance ({cur})", { cur })}>
                <input name="openingBalance" className="input" inputMode="decimal" defaultValue={n(acc.openingBalance)} />
              </Field>
              <Field label={t("As at")} hint={t("Transactions before this time are not counted. Leave empty to count everything.")}>
                <input name="openingAt" type="datetime-local" className="input" defaultValue={acc.openingAt ? toLocalInput(acc.openingAt) : ""} />
              </Field>
              <Field
                label={t("Statement page link")}
                hint={t("Optional. The PG's or agent's own daily statement page. The system reads it every 15 minutes and matches each line with the deposits and withdrawals here.")}
              >
                <input name="statementUrl" className="input" inputMode="url" placeholder="https://…" defaultValue={acc.statementUrl ?? ""} />
              </Field>
              <Submit>{t("Save")}</Submit>
            </ActionForm>
          ) : (
            <p className="text-sm">{money(acc.openingBalance, cur)}</p>
          )}
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <RangeBar brand={false} path={`/reconcile/${acc.id}`} range={range} params={{}} />
      </div>
      <Card flush title={t("Day by day")} note={t("Real balance shows on days it was checked")}>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("Date")}</th>
                <th className="r">{t("Opening")}</th>
                <th className="r">{t("Deposits")}</th>
                <th className="r">{t("Withdrawals")}</th>
                <th className="r">{t("Fees")}</th>
                <th className="r">{t("Moves")}</th>
                <th className="r">{t("Closing")}</th>
                <th className="r">
                  {t("Change")} <Info>{t("Closing − opening for the day. Compare it with “remaining” on PG pages that only show one day.")}</Info>
                </th>
                <th className="r">{t("Real balance")}</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => {
                const c = checkByDay.get(d.day);
                const diff = c ? n(c.actual) - n(c.expected) : 0;
                return (
                  <tr key={d.day}>
                    <td className="whitespace-nowrap">{d.day}</td>
                    <td className="r text-ink-2">{money(d.opening, cur)}</td>
                    <td className="r">
                      {d.deposits ? `+${money(d.deposits, cur)}` : "–"}
                      {d.depositCount > 0 && <span className="text-xs text-muted"> ×{count(d.depositCount)}</span>}
                    </td>
                    <td className="r">
                      {d.withdrawals ? `−${money(d.withdrawals, cur)}` : "–"}
                      {d.withdrawCount > 0 && <span className="text-xs text-muted"> ×{count(d.withdrawCount)}</span>}
                    </td>
                    <td className="r text-ink-2">{d.fees ? `−${money(d.fees, cur)}` : "–"}</td>
                    <td className={`r ${d.moves < 0 ? "text-critical-ink" : d.moves > 0 ? "text-good-ink" : "text-muted"}`}>{d.moves ? money(d.moves, cur) : "–"}</td>
                    <td className="r font-medium">{money(d.closing, cur)}</td>
                    <td className={`r ${d.change < 0 ? "text-critical-ink" : d.change > 0 ? "text-good-ink" : "text-muted"}`}>
                      {d.change ? `${d.change > 0 ? "+" : ""}${money(d.change, cur)}` : "–"}
                    </td>
                    <td className="r">
                      {c ? (
                        <>
                          {money(c.actual, cur)}
                          <div className={`text-xs ${Math.abs(diff) > settings.reconTolerance ? "text-critical-ink" : "text-good-ink"}`}>
                            {Math.abs(diff) > settings.reconTolerance ? `${diff > 0 ? "+" : ""}${money(diff, cur)}` : "✓"}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted">–</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card flush title={t("Balance checks")} note={t("Latest 20")}>
          <ul className="divide-y divide-[var(--line)] text-sm">
            {checks.map((c) => {
              const diff = n(c.actual) - n(c.expected);
              const off = Math.abs(diff) > settings.reconTolerance;
              return (
                <li key={c.id} className="flex gap-3 px-4 py-2.5">
                  <div className="flex-1">
                    <div>
                      {money(c.actual, cur)} <span className="text-xs text-muted">({t("system")} {money(c.expected, cur)})</span>
                    </div>
                    <div className="text-xs text-muted">
                      {dt(c.at)} · {c.userName}
                      {c.note && ` · ${c.note}`}
                    </div>
                  </div>
                  <span className={`text-sm font-medium ${off ? (c.resolved ? "text-ink-2" : "text-critical-ink") : "text-good-ink"}`}>
                    {off ? `${diff > 0 ? "+" : ""}${money(diff, cur)}` : "✓"}
                  </span>
                </li>
              );
            })}
            {checks.length === 0 && <li className="px-4 py-6 text-center text-ink-2">{t("No balance entered yet")}</li>}
          </ul>
        </Card>
        <Card flush title={t("Transfers and other movements")} note={t("Latest 20")}>
          <ul className="divide-y divide-[var(--line)] text-sm">
            {moves.map((m) => (
              <li key={m.id} className="flex gap-3 px-4 py-2.5">
                <div className="flex-1">
                  <div>{t(MOVE_LABEL[m.kind] ?? m.kind)}</div>
                  {(m.note || m.party) && <div className="text-xs text-ink-2">{moveDetail(m, cur, t)}</div>}
                  <div className="text-xs text-muted">
                    {dt(m.at)} · {m.userName}
                  </div>
                </div>
                <span className={`font-medium ${n(m.amount) < 0 ? "text-critical-ink" : "text-good-ink"}`}>
                  {n(m.amount) > 0 ? "+" : ""}
                  {money(m.amount, cur)}
                </span>
              </li>
            ))}
            {moves.length === 0 && <li className="px-4 py-6 text-center text-ink-2">{t("Nothing recorded yet")}</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
