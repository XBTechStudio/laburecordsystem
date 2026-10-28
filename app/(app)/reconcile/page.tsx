import Link from "next/link";
import { ActionButton, Dialog } from "@/components/client";
import { Card, Chip, Empty, Info, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { expectedBalances } from "@/lib/balances";
import { dayStart, todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { ago, dt, money, n } from "@/lib/format";
import { tk } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";
import { deleteCheck, deleteMove } from "./actions";
import { BalanceForm, MoveForm, ResolveForm, TransferForm } from "./forms";

const MOVE_LABEL: Record<string, string> = {
  TRANSFER_IN: tk("Transfer in"),
  TRANSFER_OUT: tk("Transfer out"),
  TOPUP: tk("Money put in"),
  CASHOUT: tk("Money taken out"),
  FEE: tk("Bank / PG charge"),
  ADJUST: tk("Correction"),
};

function hoursAgo(h: number) {
  return new Date(Date.now() - h * 3600_000);
}

export default async function ReconcilePage() {
  const user = await requirePage("reconcile");
  const [t, settings] = await Promise.all([getT(), getSettings()]);
  const canAdd = can(user, "reconcile", 2);
  const full = can(user, "reconcile", 3);
  const tol = settings.reconTolerance;

  const accounts = await prisma.payChannel.findMany({ where: { active: true }, orderBy: [{ type: "asc" }, { name: "asc" }] });
  const ids = accounts.map((a) => a.id);
  const [balances, lastChecks, today, checks, moves] = await Promise.all([
    expectedBalances(new Date(), ids),
    ids.length ? prisma.balanceCheck.findMany({ where: { channelId: { in: ids } }, orderBy: { at: "desc" }, distinct: ["channelId"] }) : Promise.resolve([]),
    ids.length
      ? prisma.txn.groupBy({ by: ["channelId", "type"], where: { channelId: { in: ids }, txnAt: { gte: dayStart(todayStr()) } }, _sum: { amount: true }, _count: true })
      : Promise.resolve([]),
    prisma.balanceCheck.findMany({ orderBy: { at: "desc" }, take: 30, include: { channel: true } }),
    prisma.channelMove.findMany({ orderBy: { at: "desc" }, take: 30, include: { channel: true } }),
  ]);
  const last = new Map(lastChecks.map((c) => [c.channelId, c]));
  const todayOf = (id: number, type: string) => today.find((x) => x.channelId === id && x.type === type);
  const stale = hoursAgo(24);
  const status = (id: number) => {
    const c = last.get(id);
    if (!c) return { label: tk("Never checked"), tone: "warning" as const };
    const diff = n(c.actual) - n(c.expected);
    if (Math.abs(diff) > tol && !c.resolved) return { label: tk("Difference"), tone: "critical" as const };
    if (c.at < stale) return { label: tk("Check again"), tone: "warning" as const };
    return { label: tk("Matched"), tone: "good" as const };
  };
  const counts = { good: 0, critical: 0, warning: 0 };
  for (const a of accounts) counts[status(a.id).tone]++;
  const accs = accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }));

  return (
    <div className="max-w-[1400px] space-y-5">
      <PageHeader
        title={t("PG / bank reconciliation")}
        desc={
          <>
            {t("What each account should hold, compared with its real balance.")}{" "}
            <Info>
              {t(
                "System balance = starting balance + deposits − withdrawals − fees (each account's fee rate) ± transfers and other movements. Enter the real balance from the bank or PG and the difference shows at once. Differences up to {tol} count as matched.",
                { tol },
              )}
            </Info>
          </>
        }
        actions={
          canAdd &&
          accounts.length > 0 && (
            <>
              <Dialog label={"+ " + t("Transfer between accounts")} title={t("Transfer between accounts")}>
                <TransferForm accounts={accs} t={t} />
              </Dialog>
              <Dialog label={"+ " + t("Other movement")} title={t("Money in or out of an account")}>
                <MoveForm accounts={accs} t={t} allowAdjust={full} />
              </Dialog>
            </>
          )
        }
      />

      {accounts.length === 0 ? (
        <Card>
          <Empty title={t("No PG or bank accounts yet")}>
            {t("Add each PG and bank account in Settings → PG & bank channels, or import transactions and they are created automatically.")}
          </Empty>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label={t("Accounts")} value={String(accounts.length)} />
            <Tile label={t("Matched")} value={String(counts.good)} tone="good" />
            <Tile label={t("Difference")} value={String(counts.critical)} tone={counts.critical ? "critical" : undefined} />
            <Tile label={t("Not checked in 24 hours")} value={String(counts.warning)} tone={counts.warning ? "warning" : undefined} />
          </div>

          <Card flush>
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("Account")}</th>
                    <th className="r">{t("System balance now")}</th>
                    <th className="r">{t("Last real balance")}</th>
                    <th className="r">{t("Difference")}</th>
                    <th>{t("Status")}</th>
                    <th className="r">{t("Today")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const b = balances.get(a.id);
                    const c = last.get(a.id);
                    const diff = c ? n(c.actual) - n(c.expected) : 0;
                    const st = status(a.id);
                    const dep = todayOf(a.id, "DEPOSIT");
                    const wd = todayOf(a.id, "WITHDRAW");
                    const noStart = !a.openingAt && n(a.openingBalance) === 0;
                    return (
                      <tr key={a.id}>
                        <td>
                          <Link href={`/reconcile/${a.id}`} className="font-medium hover:underline">
                            {a.name}
                          </Link>
                          <div className="text-xs text-muted">
                            {a.type === "PG" ? t("Payment gateway") : t("Bank")} · {a.currency}
                            {noStart && (
                              <>
                                {" · "}
                                <Link href={`/reconcile/${a.id}`} className="text-warning-ink hover:underline">
                                  {t("set starting balance")}
                                </Link>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="r text-base font-semibold">{money(b?.expected ?? 0, a.currency)}</td>
                        <td className="r">
                          {c ? (
                            <>
                              {money(c.actual, a.currency)}
                              <div className="text-xs text-muted">
                                {ago(c.at, t)} · {c.userName}
                              </div>
                            </>
                          ) : (
                            <span className="text-muted">–</span>
                          )}
                        </td>
                        <td className={`r font-medium ${c && Math.abs(diff) > tol ? "text-critical-ink" : "text-muted"}`}>
                          {c && Math.abs(diff) > tol ? (diff > 0 ? "+" : "") + money(diff, a.currency) : "–"}
                        </td>
                        <td>
                          <Chip tone={st.tone}>{t(st.label)}</Chip>
                          {c?.resolved && Math.abs(diff) > tol && <div className="mt-0.5 text-xs text-muted">{t("explained")}</div>}
                        </td>
                        <td className="r text-xs whitespace-nowrap">
                          <div className="text-good-ink">
                            +{money(dep?._sum.amount ?? 0, a.currency)} <span className="text-muted">×{dep?._count ?? 0}</span>
                          </div>
                          <div className="text-ink-2">
                            −{money(wd?._sum.amount ?? 0, a.currency)} <span className="text-muted">×{wd?._count ?? 0}</span>
                          </div>
                        </td>
                        <td className="r space-x-1 whitespace-nowrap">
                          {canAdd && (
                            <Dialog label={t("Enter balance")} title={t("Real balance of {name}", { name: a.name })} className="btn btn-primary btn-sm">
                              <BalanceForm
                                acc={{ id: a.id, name: a.name, currency: a.currency }}
                                t={t}
                                today={{ deposits: n(dep?._sum.amount), depositCount: dep?._count ?? 0, withdrawals: n(wd?._sum.amount), withdrawCount: wd?._count ?? 0 }}
                              />
                            </Dialog>
                          )}
                          <Link href={`/reconcile/${a.id}`} className="btn btn-sm">
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

          <div className="grid gap-5 xl:grid-cols-2">
            <Card flush title={t("Balance checks")} note={t("Latest 30")}>
              {checks.length === 0 ? (
                <Empty title={t("No balance entered yet")}>{t("Use “Enter balance” on an account to compare it with the bank.")}</Empty>
              ) : (
                <TableWrap>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t("When")}</th>
                        <th>{t("Account")}</th>
                        <th className="r">{t("Real")}</th>
                        <th className="r">{t("System")}</th>
                        <th className="r">{t("Difference")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {checks.map((c) => {
                        const diff = n(c.actual) - n(c.expected);
                        const off = Math.abs(diff) > tol;
                        return (
                          <tr key={c.id}>
                            <td className="whitespace-nowrap text-ink-2">
                              {dt(c.at)}
                              <div className="text-xs text-muted">{c.userName}</div>
                            </td>
                            <td className="font-medium">{c.channel.name}</td>
                            <td className="r">{money(c.actual, c.channel.currency)}</td>
                            <td className="r text-ink-2">{money(c.expected, c.channel.currency)}</td>
                            <td className={`r font-medium ${off ? (c.resolved ? "text-ink-2" : "text-critical-ink") : "text-good-ink"}`}>
                              {off ? (diff > 0 ? "+" : "") + money(diff, c.channel.currency) : "✓"}
                              {c.note && <div className="max-w-48 truncate text-xs font-normal text-muted">{c.note}</div>}
                            </td>
                            <td className="r space-x-1 whitespace-nowrap">
                              {off && !c.resolved && full && (
                                <Dialog label={t("Resolve")} title={t("Difference on {name}", { name: c.channel.name })}>
                                  <ResolveForm id={c.id} diff={(diff > 0 ? "+" : "") + money(diff, c.channel.currency)} t={t} />
                                </Dialog>
                              )}
                              {full && (
                                <ActionButton action={deleteCheck} fields={{ id: c.id }} question={t("Delete this balance check?")} className="btn btn-ghost btn-sm text-muted">
                                  ✕
                                </ActionButton>
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
            <Card flush title={t("Transfers and other movements")} note={t("Latest 30")}>
              {moves.length === 0 ? (
                <Empty title={t("Nothing recorded yet")}>{t("Record money moved between accounts, top-ups, cash-outs and bank charges, so system balances stay right.")}</Empty>
              ) : (
                <TableWrap>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t("When")}</th>
                        <th>{t("Account")}</th>
                        <th>{t("What")}</th>
                        <th className="r">{t("Amount")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {moves.map((m) => (
                        <tr key={m.id}>
                          <td className="whitespace-nowrap text-ink-2">
                            {dt(m.at)}
                            <div className="text-xs text-muted">{m.userName}</div>
                          </td>
                          <td className="font-medium">{m.channel.name}</td>
                          <td>
                            {t(MOVE_LABEL[m.kind] ?? m.kind)}
                            {m.note && <div className="max-w-56 truncate text-xs text-muted">{m.note}</div>}
                          </td>
                          <td className={`r font-medium ${n(m.amount) < 0 ? "text-critical-ink" : "text-good-ink"}`}>
                            {n(m.amount) > 0 ? "+" : ""}
                            {money(m.amount, m.channel.currency)}
                          </td>
                          <td className="r">
                            {full && (
                              <ActionButton
                                action={deleteMove}
                                fields={{ id: m.id }}
                                question={m.transferRef ? t("Delete this transfer? Both sides are removed.") : t("Delete this movement?")}
                                className="btn btn-ghost btn-sm text-muted"
                              >
                                ✕
                              </ActionButton>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "good" | "critical" | "warning" }) {
  const color = tone === "critical" ? "text-critical-ink" : tone === "good" ? "text-good-ink" : tone === "warning" ? "text-warning-ink" : "";
  return (
    <div className="card p-3.5">
      <div className="text-xs text-ink-2">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}
