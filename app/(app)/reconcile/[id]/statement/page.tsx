import Link from "next/link";
import { notFound } from "next/navigation";
import { RangeBar } from "@/components/range";
import { requirePage } from "@/lib/auth";
import { ledger, type LedgerDay } from "@/lib/balances";
import { isPg, TYPE_LABEL } from "@/lib/channel-type";
import { parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { money, n } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { PrintButton } from "./print";

const dmy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

/** "2.0" for a whole number, otherwise the rate without trailing zeros. */
const feeRate = (v: number) => {
  const s = n(v).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return s.includes(".") ? s : `${s}.0`;
};

const sum = (days: LedgerDay[], pick: (d: LedgerDay) => number) => Math.round(days.reduce((a, d) => a + pick(d), 0) * 100) / 100;

export default async function StatementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePage("reconcile");
  const id = Number((await params).id);
  const sp = await searchParams;
  const acc = Number.isInteger(id) ? await prisma.payChannel.findUnique({ where: { id } }) : null;
  if (!acc) notFound();
  const t = await getT();
  const range = parseRange(sp, "month");
  const days = await ledger(id, range);
  const cur = acc.currency;
  const pg = isPg(acc.type);
  const broughtForward = days[0]?.opening ?? 0;
  const grand = days[days.length - 1]?.closing ?? broughtForward;
  const rate = `${feeRate(n(acc.feePercent))}/${feeRate(n(acc.wdFeePercent))}`;

  const cols = (d: LedgerDay) => (
    <>
      <td className="r in">{money(d.deposits, cur)}</td>
      <td className="r out">{money(d.withdrawals, cur)}</td>
      <td className="r net">{money(Math.round((d.deposits - d.withdrawals) * 100) / 100, cur)}</td>
      <td className="r in">{money(d.settleIn, cur)}</td>
      <td className="r out">{money(d.settleOut, cur)}</td>
      {pg && (
        <>
          <td className="r out">{money(d.setFee, cur)}</td>
          <td className="r text-ink-2">{rate}</td>
          <td className="r out">{money(d.depositFee, cur)}</td>
          <td className="r out">{money(d.wdFee, cur)}</td>
        </>
      )}
      <td className="r in font-medium">{money(d.closing, cur)}</td>
      <td className="max-w-48 truncate text-xs text-ink-2" title={d.notes}>{d.notes}</td>
    </>
  );

  return (
    <div className="max-w-[1400px] space-y-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Link href={`/reconcile/${acc.id}`} className="mr-auto text-sm text-ink-2 hover:underline">
          ← {acc.name}
        </Link>
        <RangeBar brand={false} path={`/reconcile/${acc.id}/statement`} range={range} params={{}} />
        <PrintButton label={t("Print")} />
      </div>

      <div className="statement overflow-hidden rounded-xl border border-line bg-surface">
        <div className="statement-head flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div>
            <div className="text-lg font-semibold">{acc.name}</div>
            <div className="text-xs text-white/70">
              {t(TYPE_LABEL[acc.type] ?? acc.type)} · {t("Statement period")}: {dmy(range.from)} – {dmy(range.to)}
            </div>
          </div>
          <div className="flex gap-3">
            <Total label={t("B/Forward balance")} value={money(broughtForward, cur)} />
            <Total label={t("Current grand total")} value={money(grand, cur)} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl statement-table text-xs">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("Date")}</th>
                <th className="r">{t("Pay in")}</th>
                <th className="r">{t("Pay out")}</th>
                <th className="r">{t("Total")}</th>
                <th className="r">{t("Settlement (in)")}</th>
                <th className="r">{t("Settlement (out)")}</th>
                {pg && (
                  <>
                    <th className="r">{t("Set. fee")}</th>
                    <th className="r">{t("Fee rate in / out")}</th>
                    <th className="r">{t("Pay in fee")}</th>
                    <th className="r">{t("Pay out fee")}</th>
                  </>
                )}
                <th className="r">{t("Grand total")}</th>
                <th>{t("Notes")}</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d.day} className={i % 2 ? "bg-surface-2/60" : ""}>
                  <td className="text-muted">{i + 1}</td>
                  <td className="whitespace-nowrap">{dmy(d.day)}</td>
                  {cols(d)}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>{t("Total")}</td>
                <td className="r in">{money(sum(days, (d) => d.deposits), cur)}</td>
                <td className="r out">{money(sum(days, (d) => d.withdrawals), cur)}</td>
                <td className="r net">{money(sum(days, (d) => d.deposits - d.withdrawals), cur)}</td>
                <td className="r in">{money(sum(days, (d) => d.settleIn), cur)}</td>
                <td className="r out">{money(sum(days, (d) => d.settleOut), cur)}</td>
                {pg && (
                  <>
                    <td className="r out">{money(sum(days, (d) => d.setFee), cur)}</td>
                    <td className="r">{rate}</td>
                    <td className="r out">{money(sum(days, (d) => d.depositFee), cur)}</td>
                    <td className="r out">{money(sum(days, (d) => d.wdFee), cur)}</td>
                  </>
                )}
                <td className="r in">{money(grand, cur)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-36 rounded-lg bg-white px-3 py-2 text-right text-ink">
      <div className="text-[10px] font-medium tracking-wide text-muted uppercase">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
