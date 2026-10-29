import { ActionButton, ActionForm, AutoSelect, Dialog, Submit } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Chip, Empty, Field, Info, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { count, money0, pct } from "@/lib/format";
import { emptyStat, emptyTrack, judge, promoStats, trackStats } from "@/lib/promo-stats";
import { dateOnlyStr } from "@/lib/dates";
import { PERIODS, readRule, tierText } from "@/lib/promo-rule";
import Link from "next/link";
import { RuleEditor } from "./rule-editor";
import { BoxRuleForm } from "./box-form";
import { boxText, readBox } from "@/lib/box-rule";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { saveConditions, savePromotion, togglePromotion } from "./actions";
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
  const tracked = promos.map((p) => ({ p, rule: readRule(p.rule) })).filter((x) => x.rule && x.rule.tiers.length);
  const track = await trackStats(tracked.map((x) => x.p.id), range);
  const playerTiers = [...settings.tierScoring.tiers.map((x) => x.name), settings.tierScoring.lowestName];

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
                <fieldset>
                  <legend className="label">{t("Brands")}</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                    {scope.brands.map((b) => (
                      <label key={b.id} className="flex items-center gap-2">
                        <input type="checkbox" name="brandId" value={b.id} defaultChecked={scope.current ? b.id === scope.current.id : scope.brands.length === 1} className="h-4 w-4 accent-[var(--brand)]" />
                        {b.name}
                      </label>
                    ))}
                  </div>
                  <span className="hint block">{t("Each brand ticked gets its own copy with its own figures. Set the claim conditions afterwards with “Conditions”.")}</span>
                </fieldset>
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

      {tracked.length > 0 && (
        <Card
          flush
          className="mb-5"
          title={t("Tracked promotions")}
          note={t("Reminders and bonuses in the selected dates. Click a promotion to see each player's progress.")}
        >
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Promotion")}</th>
                  {multi && <th>{t("Brand")}</th>}
                  <th>{t("Conditions")}</th>
                  <th className="r">{t("Reminded")}</th>
                  <th className="r">{t("Contacted")}</th>
                  <th className="r">{t("Qualified after reminder")}</th>
                  <th className="r">{t("Eligible")}</th>
                  <th className="r">{t("Claimed")}</th>
                  <th className="r">{t("Expired")}</th>
                  <th className="r">{t("Not claimed yet")}</th>
                  <th className="r">{t("Claim rate")}</th>
                </tr>
              </thead>
              <tbody>
                {tracked.map(({ p, rule }) => {
                  const s = track.get(p.id) ?? emptyTrack();
                  const cur = scope.brandCurrency(p.brandId);
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link className="link font-medium" href={`/promotions/${p.id}`}>
                          {p.name}
                        </Link>
                      </td>
                      {multi && <td className="text-ink-2">{scope.brandName(p.brandId)}</td>}
                      <td className="text-xs text-ink-2">
                        <div>{t(PERIODS.find((x) => x.value === rule!.period)!.label)}{rule!.payNext ? " · " + t("bonus next period") : ""}</div>
                        {rule!.tiers.slice(0, 3).map((tr, i) => (
                          <div key={i}>{tierText(rule!, tr, t, cur)}</div>
                        ))}
                        {rule!.tiers.length > 3 && <div>+{rule!.tiers.length - 3}</div>}
                      </td>
                      <td className="r">{count(s.reminded)}</td>
                      <td className="r">{count(s.contacted)}</td>
                      <td className="r">
                        {count(s.reachedAfter)} {s.reminded ? <span className="text-xs text-muted">{pct((s.reachedAfter / s.reminded) * 100, 0)}</span> : null}
                      </td>
                      <td className="r">{count(s.eligible)}</td>
                      <td className="r">
                        {count(s.claimed)} <span className="text-xs text-muted">{money0(s.claimedBonus, cur)}</span>
                      </td>
                      <td className={`r ${s.expired ? "text-critical-ink" : ""}`}>{count(s.expired)}</td>
                      <td className="r">{count(s.pending)}</td>
                      <td className="r">{s.eligible ? pct((s.claimed / s.eligible) * 100, 0) : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

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
                        {readRule(p.rule) && (
                          <Link href={`/promotions/${p.id}`} className="mt-0.5 inline-block">
                            <Chip tone="brand">{t("Tracked")} · {t(PERIODS.find((x) => x.value === readRule(p.rule)!.period)!.label)}</Chip>
                          </Link>
                        )}
                        {readBox(p.box) && (
                          <Link href="/lucky-box" className="mt-0.5 ml-1 inline-block" title={boxText(readBox(p.box)!, t, cur)}>
                            <Chip tone="warning">{t("Lucky Box")}</Chip>
                          </Link>
                        )}
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
                          <Dialog label={t("Conditions")} title={t("Claim conditions: {name}", { name: p.name })} wide>
                            <ActionForm action={saveConditions} close className="space-y-4">
                              <input type="hidden" name="id" value={p.id} />
                              <RuleEditor
                                initial={readRule(p.rule)}
                                start={p.startDay ? dateOnlyStr(p.startDay) : ""}
                                end={p.endDay ? dateOnlyStr(p.endDay) : ""}
                                playerTiers={playerTiers}
                                currency={cur}
                              />
                              <div className="flex justify-end">
                                <Submit>{t("Save conditions")}</Submit>
                              </div>
                            </ActionForm>
                          </Dialog>
                          <Dialog label={t("Lucky Box")} title={t("Lucky Box: {name}", { name: p.name })}>
                            <BoxRuleForm id={p.id} rule={readBox(p.box)} currency={cur} t={t} />
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
