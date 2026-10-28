import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, Submit } from "@/components/client";
import { Card, Notice, TableWrap } from "@/components/ui";
import { canSeeBrand, requirePage } from "@/lib/auth";
import { periodLabel, periodRange, previewSettlement } from "@/lib/dividends";
import { money } from "@/lib/format";
import { LOCALE } from "@/lib/i18n";
import { getLang, getT } from "@/lib/i18n-server";
import { createSettlement } from "../actions";

/** One line of the calculation table. */
function Line({ label, v, cur, sign, strong, muted, note }: { label: string; v: number; cur: string; sign?: string; strong?: boolean; muted?: boolean; note?: string }) {
  return (
    <tr className={strong ? "bg-surface-2/60 font-semibold" : muted ? "text-muted" : ""}>
      <td>
        <span className="inline-block w-4 text-muted">{sign}</span>
        {label}
        {note && <span className="ml-1 text-xs text-muted">{note}</span>}
      </td>
      <td className={`r ${strong && v < 0 ? "text-critical-ink" : ""}`}>{money(v, cur)}</td>
    </tr>
  );
}

export default async function SettlePage({ searchParams }: { searchParams: Promise<{ brand?: string; period?: string }> }) {
  const user = await requirePage("dividends", 3);
  const sp = await searchParams;
  const brandId = Number(sp.brand);
  const range = periodRange(sp.period ?? "");
  if (!range || !Number.isInteger(brandId) || !canSeeBrand(user, brandId)) notFound();
  const [p, t, lang] = await Promise.all([previewSettlement(brandId, range.from, range.to), getT(), getLang()]);
  const cur = p.brand.currency;
  const notCounted = t("(not counted)");
  const blocked = p.overlap ? t("This period has already been settled.") : p.unfinished ? t("This period hasn't finished yet. Settle it after the last day.") : null;

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link href="/dividends?tab=settlements" className="text-sm text-ink-2 hover:underline">
          ← {t("Settlements")}
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          {p.brand.name} · {periodLabel(p.from, p.to, LOCALE[lang])}
        </h1>
        <p className="text-sm text-ink-2">
          {p.from} ~ {p.to} · {t("nothing is saved until you confirm")}
        </p>
      </div>
      {blocked && <Notice tone="warning">{blocked}</Notice>}

      <Card flush title={t("How the amount is worked out")}>
        <TableWrap>
          <table className="tbl">
            <tbody>
              <Line cur={cur} label={t("Deposits")} v={p.t.deposit} />
              <Line cur={cur} label={t("Withdrawals")} sign="−" v={p.t.withdraw} />
              <Line cur={cur} label={t("Win/Loss")} v={p.t.winlose} strong />
              {p.categories
                .filter((c) => c.kind === "INCOME")
                .map((c) => (
                  <Line key={c.name} cur={cur} label={t(c.name)} sign={c.counted ? "+" : ""} v={c.amount} muted={!c.counted} note={c.counted ? undefined : notCounted} />
                ))}
              <Line cur={cur} label={t("PG / bank fees")} sign={p.rule.deductFees ? "−" : ""} v={p.t.fees} muted={!p.rule.deductFees} note={p.rule.deductFees ? undefined : notCounted} />
              <Line cur={cur} label={t("Promotions")} sign={p.rule.deductPromos ? "−" : ""} v={p.t.promo} muted={!p.rule.deductPromos} note={p.rule.deductPromos ? undefined : notCounted} />
              {p.categories
                .filter((c) => c.kind === "EXPENSE")
                .map((c) => (
                  <Line key={c.name} cur={cur} label={t(c.name)} sign={c.counted ? "−" : ""} v={c.amount} muted={!c.counted} note={c.counted ? undefined : notCounted} />
                ))}
              <Line cur={cur} label={t("Profit for the period")} v={p.profit} strong />
              {p.rule.carryLoss && (
                <Line
                  cur={cur}
                  label={t("Loss carried in")}
                  sign={p.carriedIn < 0 ? "−" : ""}
                  v={Math.abs(p.carriedIn)}
                  muted={!p.carriedIn}
                  note={p.prev ? `${p.prev.from} ~ ${p.prev.to}` : t("(no earlier settlement)")}
                />
              )}
              {p.base > 0 && p.rule.reservePercent > 0 && <Line cur={cur} label={t("Company keeps {p}%", { p: p.rule.reservePercent })} sign="−" v={p.reserve} />}
              <Line cur={cur} label={t("To distribute")} v={p.distributable} strong />
              {p.carryOut < 0 && <Line cur={cur} label={t("Loss carried to the next period")} v={p.carryOut} muted />}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Card flush title={t("Split between shareholders")} note={t("Shares held on {date}", { date: p.to })}>
        {p.lines.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-ink-2">
            {t("No shares are set for this brand on {date}.", { date: p.to })}{" "}
            <Link className="link" href="/dividends?tab=shares">
              {t("Set brand shares")}
            </Link>
          </p>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Shareholder")}</th>
                  <th className="r">{t("Share")}</th>
                  <th className="r">{t("Amount")}</th>
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l) => (
                  <tr key={l.shareholderId}>
                    <td className="font-medium">{l.name}</td>
                    <td className="r">{l.percent}%</td>
                    <td className="r font-medium">{money(l.amount, cur)}</td>
                  </tr>
                ))}
                {p.allocated < 100 && (
                  <tr className="text-muted">
                    <td>{t("Not held by anyone (stays with the company)")}</td>
                    <td className="r">{(100 - p.allocated).toFixed(2).replace(/\.00$/, "")}%</td>
                    <td className="r">{money((p.distributable * (100 - p.allocated)) / 100, cur)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {!blocked && (
        <ActionForm action={createSettlement} className="flex flex-wrap items-center justify-end gap-3">
          <input type="hidden" name="brandId" value={brandId} />
          <input type="hidden" name="from" value={p.from} />
          <input type="hidden" name="to" value={p.to} />
          <input type="hidden" name="expected" value={p.distributable} />
          <span className="text-sm text-ink-2">{t("Once saved, these numbers stay fixed even if data or shares change later.")}</span>
          <Link href="/dividends?tab=settlements" className="btn">
            {t("Cancel")}
          </Link>
          <Submit>{t("Confirm and save settlement")}</Submit>
        </ActionForm>
      )}
    </div>
  );
}
