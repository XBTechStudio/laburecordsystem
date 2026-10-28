import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, ActionForm, Dialog, Submit } from "@/components/client";
import { Card, Chip, Field, TableWrap } from "@/components/ui";
import { can, canSeeBrand, requirePage } from "@/lib/auth";
import { todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { periodLabel } from "@/lib/dividends";
import { d10, dt, money, n } from "@/lib/format";
import { LOCALE } from "@/lib/i18n";
import { getLang, getT } from "@/lib/i18n-server";
import { deletePayment, deleteSettlement, recordPayment } from "../actions";

type Breakdown = {
  deposits: number;
  withdrawals: number;
  winlose: number;
  fees: number;
  feesDeducted: boolean;
  promotions: number;
  promotionsDeducted: boolean;
  categories: { name: string; kind: string; amount: number; counted: boolean }[];
  reservePercent: number;
  carryLoss: boolean;
  unallocatedPercent: number;
};

export default async function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePage("dividends");
  const id = Number((await params).id);
  const s = Number.isInteger(id)
    ? await prisma.settlement.findUnique({ where: { id }, include: { brand: true, lines: { include: { shareholder: true, payments: { orderBy: { paidAt: "asc" } } } } } })
    : null;
  if (!s || !canSeeBrand(user, s.brandId)) notFound();
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const manage = can(user, "dividends", 3);
  const cur = s.brand.currency;
  const b = s.breakdown as unknown as Breakdown;
  const from = d10(s.periodStart);
  const to = d10(s.periodEnd);
  const paid = s.lines.some((l) => l.payments.length > 0);
  const notCounted = ` ${t("(not counted)")}`;

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <Link href="/dividends?tab=settlements" className="text-sm text-ink-2 hover:underline">
            ← {t("Settlements")}
          </Link>
          <h1 className="mt-1 text-xl font-semibold">
            {s.brand.name} · {periodLabel(from, to, LOCALE[lang])}
          </h1>
          <p className="text-sm text-ink-2">{t("Settled by {name} on {date}", { name: s.createdBy ?? "–", date: dt(s.createdAt) })}</p>
        </div>
        {manage && !paid && (
          <ActionButton action={deleteSettlement} fields={{ id: s.id }} question={t("Delete this settlement so it can be run again?")} className="btn btn-sm">
            {t("Delete settlement")}
          </ActionButton>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["profit", t("Profit"), n(s.profit)],
          ["carried", t("Loss carried in"), n(s.carriedIn)],
          ["reserve", t("Company kept"), n(s.reserve)],
          ["dist", t("Distributed"), n(s.distributable)],
        ].map(([k, l, v]) => (
          <div key={String(k)} className="card p-3.5">
            <div className="text-xs text-ink-2">{l}</div>
            <div className={`mt-1 text-lg font-semibold ${Number(v) < 0 ? "text-critical-ink" : ""}`}>{money(Number(v), cur)}</div>
          </div>
        ))}
      </div>

      <Card flush title={t("Shareholders")}>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("Shareholder")}</th>
                <th className="r">{t("Share")}</th>
                <th className="r">{t("Entitled")}</th>
                <th className="r">{t("Paid")}</th>
                <th>{t("Status")}</th>
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => {
                const left = n(l.amount) - n(l.paid);
                return (
                  <tr key={l.id} className="align-top">
                    <td>
                      <div className="font-medium">{l.shareholder.name}</div>
                      {l.payments.map((p) => (
                        <div key={p.id} className="mt-0.5 flex items-center gap-1 text-xs text-ink-2">
                          {t("Paid {amount} on {date}", { amount: money(p.amount, cur), date: d10(p.paidAt) })}
                          {p.note && ` · ${p.note}`}
                          {manage && (
                            <ActionButton action={deletePayment} fields={{ id: p.id }} question={t("Remove this payment record?")} className="text-muted hover:text-critical-ink">
                              ✕
                            </ActionButton>
                          )}
                        </div>
                      ))}
                    </td>
                    <td className="r">{n(l.percent)}%</td>
                    <td className="r">{money(l.amount, cur)}</td>
                    <td className="r">{money(l.paid, cur)}</td>
                    <td>{left > 0.005 ? <Chip tone="warning">{t("{amount} unpaid", { amount: money(left, cur) })}</Chip> : <Chip tone="good">{t("Paid")}</Chip>}</td>
                    {manage && (
                      <td className="r">
                        {left > 0.005 && (
                          <Dialog label={t("Record payment")} title={t("Payment to {name}", { name: l.shareholder.name })}>
                            <ActionForm action={recordPayment} close className="space-y-3">
                              <input type="hidden" name="lineId" value={l.id} />
                              <div className="grid grid-cols-2 gap-3">
                                <Field label={t("Amount")} hint={t("Unpaid: {amount}", { amount: money(left, cur) })}>
                                  <input name="amount" className="input" inputMode="decimal" defaultValue={left.toFixed(2)} required />
                                </Field>
                                <Field label={t("Paid on")}>
                                  <input name="paidAt" type="date" className="input" defaultValue={todayStr()} required />
                                </Field>
                              </div>
                              <Field label={t("Note")} hint={t("e.g. bank transfer reference")}>
                                <input name="note" className="input" />
                              </Field>
                              <div className="flex justify-end">
                                <Submit>{t("Record payment")}</Submit>
                              </div>
                            </ActionForm>
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
      </Card>

      {b && (
        <Card title={t("Calculation (as saved)")} note={t("These figures were fixed when the settlement was made")}>
          <dl className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
            {[
              [t("Deposits"), money(b.deposits, cur)],
              [t("Withdrawals"), money(b.withdrawals, cur)],
              [t("Win/Loss"), money(b.winlose, cur)],
              [t("PG / bank fees") + (b.feesDeducted ? "" : notCounted), money(b.fees, cur)],
              [t("Promotions") + (b.promotionsDeducted ? "" : notCounted), money(b.promotions, cur)],
              ...b.categories.map((c) => [t(c.name) + (c.counted ? "" : notCounted), `${c.kind === "INCOME" ? "+" : "−"} ${money(c.amount, cur)}`]),
              [t("Company keeps first"), `${b.reservePercent}%`],
              [t("Losses carried forward"), b.carryLoss ? t("Yes") : t("No")],
              ...(b.unallocatedPercent > 0 ? [[t("Shares not held by anyone"), `${b.unallocatedPercent}%`]] : []),
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-line py-1">
                <dt className="text-ink-2">{k}</dt>
                <dd className="tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}
    </div>
  );
}
