"use client";

import { useState } from "react";
import { useT } from "@/components/i18n";
import { tk } from "@/lib/i18n";
import { BASES, DEFAULT_RULE, emptyTier, EXPIRY, PERIODS, tierText, type PromoRule, type PromoTier } from "@/lib/promo-rule";

/** Ready-made starting points, from the kinds of promotions brands usually run. */
const EXAMPLES: { label: string; rule: Partial<PromoRule> }[] = [
  {
    label: tk("Daily: number of deposits"),
    rule: { period: "day", basis: "count", minEach: 30, stack: true, tiers: [3, 6, 10].map((c, i) => ({ ...emptyTier(), count: c, bonus: [10, 20, 30][i] })) },
  },
  {
    label: tk("Daily: total deposited"),
    rule: { period: "day", basis: "amount", minEach: 0, stack: true, tiers: [100, 500, 1000].map((a, i) => ({ ...emptyTier(), amount: a, bonus: [8, 28, 88][i] })) },
  },
  { label: tk("Weekly: total deposited"), rule: { period: "week", basis: "amount", minEach: 0, stack: true, tiers: [{ ...emptyTier(), amount: 1000, bonus: 50 }] } },
  {
    label: tk("Monthly VIP (from last month)"),
    rule: { period: "month", basis: "amount", payNext: true, stack: false, tiers: [{ ...emptyTier(), amount: 5000, bonus: 50 }], expiry: { kind: "period", hours: 0, warnHours: 24 } },
  },
];

export function RuleEditor({
  initial,
  start,
  end,
  playerTiers,
  currency,
}: {
  initial: PromoRule | null;
  start: string;
  end: string;
  playerTiers: string[];
  currency: string;
}) {
  const t = useT();
  const [on, setOn] = useState(!!initial);
  const [r, setR] = useState<PromoRule>(initial ?? DEFAULT_RULE);
  const set = (p: Partial<PromoRule>) => setR({ ...r, ...p });
  const setTier = (i: number, p: Partial<PromoTier>) => set({ tiers: r.tiers.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const numIn = (v: number, onChange: (v: number) => void, cls = "w-24", placeholder = "0") => (
    <input className={`input ${cls}`} inputMode="decimal" value={v || ""} placeholder={placeholder} onChange={(e) => onChange(Number(e.target.value.replace(/[^\d.]/g, "")) || 0)} />
  );
  const showAmount = r.basis !== "count";
  const showCount = r.basis !== "amount";

  return (
    <div className="space-y-5">
      <input type="hidden" name="rule" value={on ? JSON.stringify(r) : ""} />
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
        <span>
          <span className="font-medium">{t("Track this promotion")}</span>
          <span className="block text-xs text-muted">{t("The system follows each player's deposits against these conditions and alerts CS when someone is close or qualifies.")}</span>
        </span>
      </label>

      {on && (
        <>
          <div>
            <div className="label">{t("Start from an example")}</div>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex.label} type="button" className="btn btn-sm" onClick={() => setR({ ...DEFAULT_RULE, ...ex.rule, remind: { ...DEFAULT_RULE.remind }, expiry: { ...DEFAULT_RULE.expiry, ...ex.rule.expiry } })}>
                  {t(ex.label)}
                </button>
              ))}
            </div>
          </div>

          <section className="space-y-3">
            <div className="text-sm font-medium">1. {t("When it counts")}</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="label">{t("Period")}</span>
                <select className="input" value={r.period} onChange={(e) => set({ period: e.target.value as PromoRule["period"], payNext: e.target.value === "campaign" ? false : r.payNext })}>
                  {PERIODS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {t(p.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">{t("Runs from")}</span>
                <input type="date" name="startDay" className="input" defaultValue={start} />
              </label>
              <label className="block">
                <span className="label">{t("Until")}</span>
                <input type="date" name="endDay" className="input" defaultValue={end} />
                <span className="hint block">{t("Leave empty for no end")}</span>
              </label>
            </div>
            {r.period !== "campaign" && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={r.payNext} onChange={(e) => set({ payNext: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
                <span>
                  {t("The bonus is for the next period")}
                  <span className="block text-xs text-muted">{t("e.g. monthly VIP: last month's total decides this month's bonus.")}</span>
                </span>
              </label>
            )}
          </section>

          <section className="space-y-3">
            <div className="text-sm font-medium">2. {t("Condition")}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="label">{t("Based on")}</span>
                <select className="input" value={r.basis} onChange={(e) => set({ basis: e.target.value as PromoRule["basis"] })}>
                  {BASES.map((b) => (
                    <option key={b.value} value={b.value}>
                      {t(b.label)}
                    </option>
                  ))}
                </select>
              </label>
              {showCount && (
                <label className="block">
                  <span className="label">
                    {t("Each deposit at least")} ({currency})
                  </span>
                  {numIn(r.minEach, (v) => set({ minEach: v }), "w-full")}
                  <span className="hint block">{t("Smaller deposits don't count. One big deposit still counts as one.")}</span>
                </label>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <div className="text-sm font-medium">3. {t("Tiers and bonus")}</div>
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-2">
                    <th className="pr-2 pb-1 font-normal">#</th>
                    {showAmount && <th className="pr-2 pb-1 font-normal">{t("Total at least")}</th>}
                    {showCount && <th className="pr-2 pb-1 font-normal">{t("Deposits at least")}</th>}
                    <th className="pr-2 pb-1 font-normal">{t("Bonus")}</th>
                    <th className="pr-2 pb-1 font-normal">{t("or % of deposits")}</th>
                    <th className="pr-2 pb-1 font-normal">{t("Max bonus")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {r.tiers.map((tr, i) => (
                    <tr key={i}>
                      <td className="pr-2 text-muted">{i + 1}</td>
                      {showAmount && <td className="py-1 pr-2">{numIn(tr.amount, (v) => setTier(i, { amount: v }))}</td>}
                      {showCount && <td className="py-1 pr-2">{numIn(tr.count, (v) => setTier(i, { count: Math.round(v) }), "w-20")}</td>}
                      <td className="py-1 pr-2">{numIn(tr.bonus, (v) => setTier(i, { bonus: v }), "w-20")}</td>
                      <td className="py-1 pr-2">{numIn(tr.pct, (v) => setTier(i, { pct: v }), "w-16", "%")}</td>
                      <td className="py-1 pr-2">{numIn(tr.cap, (v) => setTier(i, { cap: v }), "w-20", "–")}</td>
                      <td>
                        {r.tiers.length > 1 && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ tiers: r.tiers.filter((_, j) => j !== i) })} aria-label={t("Remove this tier")}>
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => set({ tiers: [...r.tiers, emptyTier()] })}>
              + {t("Add a tier")}
            </button>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={r.stack} onChange={() => set({ stack: true })} className="accent-[var(--brand)]" /> {t("Every tier reached pays (they add up)")}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={!r.stack} onChange={() => set({ stack: false })} className="accent-[var(--brand)]" /> {t("Only the highest tier reached pays")}
              </label>
            </div>
            <ul className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
              {r.tiers.map((tr, i) => (
                <li key={i}>
                  {i + 1}. {tierText(r, tr, t, currency)}
                </li>
              ))}
            </ul>
          </section>

          {playerTiers.length > 0 && (
            <section className="space-y-2">
              <div className="text-sm font-medium">4. {t("Which players")}</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                {playerTiers.map((name) => (
                  <label key={name} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--brand)]"
                      checked={r.playerTiers.includes(name)}
                      onChange={(e) => set({ playerTiers: e.target.checked ? [...r.playerTiers, name] : r.playerTiers.filter((x) => x !== name) })}
                    />
                    {t(name)}
                  </label>
                ))}
              </div>
              <span className="hint block">{t("Tick none for every player. Tiers come from Settings → Player tiers.")}</span>
            </section>
          )}

          <section className="space-y-3">
            <div className="text-sm font-medium">{playerTiers.length > 0 ? 5 : 4}. {t("Remind CS")}</div>
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="block">
                <span className="label">{t("At % of next tier")}</span>
                {numIn(r.remind.pct, (v) => set({ remind: { ...r.remind, pct: Math.min(v, 100) } }), "w-full", t("off"))}
              </label>
              {showAmount && (
                <label className="block">
                  <span className="label">{t("Or only this much missing")}</span>
                  {numIn(r.remind.gapAmount, (v) => set({ remind: { ...r.remind, gapAmount: v } }), "w-full", t("off"))}
                </label>
              )}
              {showCount && (
                <label className="block">
                  <span className="label">{t("Or only this many deposits missing")}</span>
                  {numIn(r.remind.gapCount, (v) => set({ remind: { ...r.remind, gapCount: Math.round(v) } }), "w-full", t("off"))}
                </label>
              )}
              <label className="block">
                <span className="label">{t("Remind again after (hours)")}</span>
                {numIn(r.remind.repeatHours, (v) => set({ remind: { ...r.remind, repeatHours: v } }), "w-full", t("never again"))}
                <span className="hint block">{t("If CS contacted them and they still haven't reached it")}</span>
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={r.notifyEligible} onChange={(e) => set({ notifyEligible: e.target.checked })} className="h-4 w-4 accent-[var(--brand)]" />
              {t("Also tell CS when a player qualifies")}
            </label>
          </section>

          <section className="space-y-3">
            <div className="text-sm font-medium">{playerTiers.length > 0 ? 6 : 5}. {t("Claim deadline")}</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="label">{t("Bonus can be claimed")}</span>
                <select className="input" value={r.expiry.kind} onChange={(e) => set({ expiry: { ...r.expiry, kind: e.target.value as PromoRule["expiry"]["kind"] } })}>
                  {EXPIRY.map((x) => (
                    <option key={x.value} value={x.value}>
                      {t(x.label)}
                    </option>
                  ))}
                </select>
              </label>
              {r.expiry.kind === "hours" && (
                <label className="block">
                  <span className="label">{t("Hours after qualifying")}</span>
                  {numIn(r.expiry.hours, (v) => set({ expiry: { ...r.expiry, hours: v } }), "w-full")}
                </label>
              )}
              {r.expiry.kind !== "none" && (
                <label className="block">
                  <span className="label">{t("Remind before it expires (hours)")}</span>
                  {numIn(r.expiry.warnHours, (v) => set({ expiry: { ...r.expiry, warnHours: v } }), "w-full", t("off"))}
                </label>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
