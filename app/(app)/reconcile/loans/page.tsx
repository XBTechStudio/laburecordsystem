import { ActionButton, Dialog } from "@/components/client";
import { Card, Empty, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { dt, money, n } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { LOAN_KINDS, MOVE_LABEL } from "@/lib/move-kinds";
import { deleteMove } from "../actions";
import { LoanForm } from "../forms";
import { ReconcileTabs } from "../parts";

type Sum = { party: string; currency: string; lent: number; back: number; borrowed: number; repaid: number; last: Date };

/** Lending between operators (同行互借): who owes whom, worked out from every loan and repayment recorded on our accounts. */
export default async function LoansPage() {
  const user = await requirePage("reconcile");
  const t = await getT();
  const canAdd = can(user, "reconcile", 2);
  const full = can(user, "reconcile", 3);
  const [moves, accounts] = await Promise.all([
    prisma.channelMove.findMany({ where: { kind: { in: [...LOAN_KINDS] } }, orderBy: { at: "desc" }, include: { channel: { select: { name: true, currency: true } } } }),
    prisma.payChannel.findMany({ where: { active: true }, orderBy: [{ type: "asc" }, { name: "asc" }], select: { id: true, name: true, currency: true } }),
  ]);

  const sums = new Map<string, Sum>();
  for (const m of moves) {
    const party = m.party ?? "–";
    const k = `${party.toLowerCase()}|${m.channel.currency}`;
    const s = sums.get(k) ?? { party, currency: m.channel.currency, lent: 0, back: 0, borrowed: 0, repaid: 0, last: m.at };
    const v = Math.abs(n(m.amount));
    if (m.kind === "LEND_OUT") s.lent += v;
    else if (m.kind === "LEND_BACK") s.back += v;
    else if (m.kind === "BORROW_IN") s.borrowed += v;
    else s.repaid += v;
    if (m.at > s.last) s.last = m.at;
    sums.set(k, s);
  }
  const rows = [...sums.values()].sort((a, b) => Math.abs(b.borrowed - b.repaid) + Math.abs(b.lent - b.back) - (Math.abs(a.borrowed - a.repaid) + Math.abs(a.lent - a.back)));
  const parties = [...new Set(moves.map((m) => m.party).filter(Boolean) as string[])].sort();
  const r2 = (v: number) => Math.round(v * 100) / 100;

  return (
    <div className="max-w-[1400px] space-y-5">
      <div>
        <PageHeader
          title={t("PG / bank reconciliation")}
          desc={t("Money lent to and borrowed from other operators, and what is still owed either way.")}
          actions={
            canAdd &&
            accounts.length > 0 && (
              <Dialog label={"+ " + t("Record loan or repayment")} title={t("Operator loans")} className="btn btn-primary">
                <LoanForm accounts={accounts} parties={parties} t={t} />
              </Dialog>
            )
          }
        />
        <ReconcileTabs active="loans" t={t} />
      </div>

      <Card flush title={t("Who owes whom")} note={t("Each loan and repayment also moves the account balance it was paid from or into.")}>
        {rows.length === 0 ? (
          <Empty title={t("Nothing recorded yet")}>{t("Record a loan to or from another operator; repayments are recorded the same way.")}</Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Operator")}</th>
                  <th className="r">{t("We lent")}</th>
                  <th className="r">{t("Paid back to us")}</th>
                  <th className="r">{t("They still owe us")}</th>
                  <th className="r">{t("We borrowed")}</th>
                  <th className="r">{t("We paid back")}</th>
                  <th className="r">{t("We still owe")}</th>
                  <th>{t("Last")}</th>
                  {canAdd && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const owedToUs = r2(s.lent - s.back);
                  const weOwe = r2(s.borrowed - s.repaid);
                  return (
                    <tr key={`${s.party}|${s.currency}`}>
                      <td className="font-medium">
                        {s.party}
                        <div className="text-xs text-muted">{s.currency}</div>
                      </td>
                      <td className="r">{money(s.lent, s.currency)}</td>
                      <td className="r">{money(s.back, s.currency)}</td>
                      <td className={`r font-semibold ${owedToUs > 0 ? "text-good-ink" : owedToUs < 0 ? "text-critical-ink" : "text-muted"}`}>{money(owedToUs, s.currency)}</td>
                      <td className="r">{money(s.borrowed, s.currency)}</td>
                      <td className="r">{money(s.repaid, s.currency)}</td>
                      <td className={`r font-semibold ${weOwe > 0 ? "text-critical-ink" : weOwe < 0 ? "text-good-ink" : "text-muted"}`}>{money(weOwe, s.currency)}</td>
                      <td className="whitespace-nowrap text-ink-2">{dt(s.last)}</td>
                      {canAdd && (
                        <td className="r space-x-1 whitespace-nowrap">
                          {owedToUs > 0 && (
                            <Dialog label={t("They paid back")} title={t("Operator loans")}>
                              <LoanForm accounts={accounts} parties={parties} party={s.party} kind="LEND_BACK" t={t} />
                            </Dialog>
                          )}
                          {weOwe > 0 && (
                            <Dialog label={t("We paid back")} title={t("Operator loans")}>
                              <LoanForm accounts={accounts} parties={parties} party={s.party} kind="BORROW_BACK" t={t} />
                            </Dialog>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card flush title={t("History")} note={t("Latest 200")}>
        {moves.length === 0 ? (
          <Empty title={t("Nothing recorded yet")} />
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("When")}</th>
                  <th>{t("Operator")}</th>
                  <th>{t("What")}</th>
                  <th>{t("Account")}</th>
                  <th className="r">{t("Amount")}</th>
                  <th>{t("Note")}</th>
                  {full && <th />}
                </tr>
              </thead>
              <tbody>
                {moves.slice(0, 200).map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap text-ink-2">
                      {dt(m.at)}
                      <div className="text-xs text-muted">{m.userName}</div>
                    </td>
                    <td className="font-medium">{m.party}</td>
                    <td>{t(MOVE_LABEL[m.kind] ?? m.kind)}</td>
                    <td className="text-ink-2">{m.channel.name}</td>
                    <td className={`r font-medium ${n(m.amount) < 0 ? "text-critical-ink" : "text-good-ink"}`}>
                      {n(m.amount) > 0 ? "+" : ""}
                      {money(m.amount, m.channel.currency)}
                    </td>
                    <td className="max-w-56 truncate text-ink-2">{m.note ?? ""}</td>
                    {full && (
                      <td className="r">
                        <ActionButton action={deleteMove} fields={{ id: m.id }} question={t("Delete this movement?")} className="btn btn-ghost btn-sm text-muted">
                          ✕
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
