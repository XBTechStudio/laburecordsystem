import { ActionButton, ActionForm, AutoSelect, Dialog, Submit } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Chip, Empty, Field, Info, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { count, money0, pct } from "@/lib/format";
import { emptyStat, judge, promoStats } from "@/lib/promo-stats";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { savePromotion, togglePromotion } from "./actions";
import { tk } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";

const VERDICT: Record<string, [string, "good" | "warning" | "critical" | "neutral"]> = {
  none: [tk("No claims"), "neutral"],
  cancel: [tk("Cancel"), "critical"],
  adjust: [tk("Adjust"), "warning"],
  keep: [tk("Keep"), "good"],
};

export default async function PromotionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("promotions");
  const sp = await searchParams;
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const range = parseRange(sp, "month");
  const manage = can(user, "promotions", 3);
  const showEnded = sp.ended === "1";
  const ids = scope.brandIds;

  const promos = ids.length
    ? await prisma.promotion.findMany({ where: { brandId: { in: ids }, ...(showEnded ? {} : { active: true }) }, orderBy: [{ active: "desc" }, { name: "asc" }] })
    : [];
  const stats = await promoStats(ids, range, settings.promoWindowDays);

  const rows = promos
    .map((p) => {
      const s = stats.get(p.id) ?? emptyStat();
      const j = judge(s, settings.promoAdjustPercent);
      return { p, s, net: j.net, cost: j.cost, verdict: VERDICT[j.verdict] };
    })
    .sort((a, b) => b.s.given - a.s.given);
  const totals = rows.reduce(
    (a, r) => {
      const k = scope.rate(r.p.brandId);
      return { given: a.given + r.s.given * k, dep: a.dep + r.s.dep * k, net: a.net + r.net * k, claims: a.claims + r.s.claims };
    },
    { given: 0, dep: 0, net: 0, claims: 0 },
  );
  const multi = !scope.current;

  return (
    <div className="max-w-[1400px]">
      <PageHeader
        title={t("Promotions")}
        desc={
          <>
            {t("What each promotion cost and what its claimers did afterwards.")}{" "}
            <Info>
              {t("A claimer's deposits and withdrawals count from their first claim in the period until {n} days after their last claim. “W/L after promo” = their deposits − withdrawals − bonus given. Suggestion: Cancel if that is negative, Adjust if the bonus is over {p}% of their deposits, otherwise Keep. Change these in Settings.", { n: settings.promoWindowDays, p: settings.promoAdjustPercent })}
            </Info>
          </>
        }
        actions={
          manage && (
            <Dialog label={"+ " + t("Add promotion")} title={t("Add promotion")} className="btn btn-primary">
              <ActionForm action={savePromotion} close className="space-y-3">
                <Field label={t("Brand")}>
                  <select name="brandId" className="input" defaultValue={scope.current?.id ?? scope.brands[0]?.id}>
                    {scope.brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("Name")}>
                  <input name="name" className="input" required placeholder={t("e.g. Weekend reload 10%")} />
                </Field>
                <Field label={t("Note")}>
                  <input name="note" className="input" placeholder={t("Terms, dates…")} />
                </Field>
                <div className="flex justify-end">
                  <Submit>{t("Add")}</Submit>
                </div>
              </ActionForm>
            </Dialog>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RangeBar path="/promotions" range={range} params={sp} />
        <form action="/promotions">
          {Object.entries(sp)
            .filter(([k, v]) => v && k !== "ended")
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <AutoSelect name="ended" defaultValue={showEnded ? "1" : ""} className="input h-8 w-auto">
            <option value="">{t("Running promotions")}</option>
            <option value="1">{t("Include ended ones")}</option>
          </AutoSelect>
        </form>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["given", t("Bonus given"), money0(totals.given, scope.currency)],
          ["claims", t("Claims"), count(totals.claims)],
          ["dep", t("Claimers' deposits"), money0(totals.dep, scope.currency)],
          ["net", t("W/L after promotions"), money0(totals.net, scope.currency)],
        ].map(([k, l, v]) => (
          <div key={k} className="card p-3.5">
            <div className="text-xs text-ink-2">{l}</div>
            <div className={`mt-1 text-lg font-semibold ${k === "net" && totals.net < 0 ? "text-critical-ink" : ""}`}>{v}</div>
          </div>
        ))}
      </div>

      <Card flush>
        {rows.length === 0 ? (
          <Empty title={t("No promotions yet")}>{t("Promotions are created here, or automatically when claims are entered or imported.")}</Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Promotion")}</th>
                  {multi && <th>{t("Brand")}</th>}
                  <th className="r">{t("Claimers")}</th>
                  <th className="r">{t("Claims")}</th>
                  <th className="r">{t("Bonus given")}</th>
                  <th className="r">{t("Claimers' deposits")}</th>
                  <th className="r">{t("Claimers' withdrawals")}</th>
                  <th className="r">{t("Cost ratio")}</th>
                  <th className="r">{t("W/L after promo")}</th>
                  <th>{t("Suggestion")}</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, s, net, cost, verdict }) => {
                  const cur = scope.brandCurrency(p.brandId);
                  return (
                    <tr key={p.id} className={p.active ? "" : "opacity-60"}>
                      <td>
                        <div className="font-medium">{p.name}</div>
                        {p.note && <div className="max-w-64 truncate text-xs text-muted">{p.note}</div>}
                        {!p.active && <div className="text-xs text-muted">{t("Ended")}</div>}
                      </td>
                      {multi && <td className="text-ink-2">{scope.brandName(p.brandId)}</td>}
                      <td className="r">{count(s.claimers)}</td>
                      <td className="r">{count(s.claims)}</td>
                      <td className="r">{money0(s.given, cur)}</td>
                      <td className="r">
                        {money0(s.dep, cur)} <span className="text-xs text-muted">×{s.depCount}</span>
                      </td>
                      <td className="r">
                        {money0(s.wd, cur)} <span className="text-xs text-muted">×{s.wdCount}</span>
                      </td>
                      <td className="r">{Number.isFinite(cost) ? pct(cost) : "–"}</td>
                      <td className={`r font-medium ${net < 0 ? "text-critical-ink" : ""}`}>{s.claims ? money0(net, cur) : "–"}</td>
                      <td>
                        <Chip tone={verdict[1]}>{t(verdict[0])}</Chip>
                      </td>
                      {manage && (
                        <td className="r space-x-1">
                          <Dialog label={t("Edit")} title={t("Edit {name}", { name: p.name })}>
                            <ActionForm action={savePromotion} close className="space-y-3">
                              <input type="hidden" name="id" value={p.id} />
                              <Field label={t("Name")}>
                                <input name="name" className="input" defaultValue={p.name} required />
                              </Field>
                              <Field label={t("Note")}>
                                <input name="note" className="input" defaultValue={p.note ?? ""} />
                              </Field>
                              <div className="flex justify-end">
                                <Submit>{t("Save")}</Submit>
                              </div>
                            </ActionForm>
                          </Dialog>
                          <ActionButton action={togglePromotion} fields={{ id: p.id }}>
                            {p.active ? t("End") : t("Restart")}
                          </ActionButton>
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
    </div>
  );
}
