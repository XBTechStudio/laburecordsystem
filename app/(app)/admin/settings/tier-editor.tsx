"use client";

import { useState } from "react";
import { useT } from "@/components/i18n";
import { tk } from "@/lib/i18n";
import { scorePlayer, type TierScoring } from "@/lib/tiers";

/** Tier rule inputs with a live "what tier would this player get" preview. */
export function TierEditor({ initial, readOnly }: { initial: TierScoring; readOnly: boolean }) {
  const [s, setS] = useState(initial);
  const [tiers, setTiers] = useState(initial.tiers.length ? initial.tiers : [{ name: "", minScore: 50 }]);
  const [test, setTest] = useState({ total: 5000, count: 12 });
  const t = useT();
  const set = (k: keyof TierScoring) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) || 0 });
  const result = scorePlayer({ ...s, tiers }, test.total, test.count);
  const numInput = (k: keyof TierScoring, label: string, hint: string) => (
    <label className="block">
      <span className="label">{t(label)}</span>
      <input name={k} className="input" inputMode="decimal" value={String(s[k])} onChange={set(k)} disabled={readOnly} />
      <span className="hint block">{t(hint)}</span>
    </label>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div className="space-y-5">
        <div>
          <div className="mb-2 text-sm font-medium">1. {t("What counts as a perfect score")}</div>
          <div className="grid gap-3 sm:grid-cols-3">
            {numInput("amountFull", tk("Total deposits"), tk("Full marks at this lifetime amount"))}
            {numInput("countFull", tk("Number of deposits"), tk("Full marks at this many deposits"))}
            {numInput("avgFull", tk("Average deposit"), tk("Full marks at this average"))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">2. {t("How much each part matters")}</div>
          <div className="grid gap-3 sm:grid-cols-3">
            {numInput("weightAmount", tk("Weight: total"), tk("e.g. 50"))}
            {numInput("weightCount", tk("Weight: count"), tk("e.g. 30"))}
            {numInput("weightAvg", tk("Weight: average"), tk("e.g. 20"))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">3. {t("Tiers (score 0–100)")}</div>
          <div className="space-y-2">
            {tiers.map((tr, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  name="tierName"
                  className="input"
                  value={tr.name}
                  placeholder={t("Tier name")}
                  disabled={readOnly}
                  onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <span className="text-sm whitespace-nowrap text-ink-2">{t("score ≥")}</span>
                <input
                  name="tierMin"
                  className="input w-20"
                  inputMode="numeric"
                  value={tr.minScore}
                  disabled={readOnly}
                  onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, minScore: Number(e.target.value) || 0 } : x)))}
                />
                {!readOnly && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTiers(tiers.filter((_, j) => j !== i))} aria-label={t("Remove tier")}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input
                name="lowestName"
                className="input"
                value={s.lowestName}
                disabled={readOnly}
                onChange={(e) => setS({ ...s, lowestName: e.target.value })}
              />
              <span className="text-sm whitespace-nowrap text-ink-2">{t("everyone else")}</span>
            </div>
            {!readOnly && tiers.length < 6 && (
              <button type="button" className="btn btn-sm" onClick={() => setTiers([...tiers, { name: "", minScore: 0 }])}>
                + {t("Add tier")}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="h-fit rounded-xl bg-surface-2 p-4">
        <div className="text-sm font-medium">{t("Try it")}</div>
        <p className="mt-0.5 text-xs text-ink-2">{t("See which tier a player would get with these rules.")}</p>
        <label className="mt-3 block">
          <span className="label">{t("Lifetime deposits")}</span>
          <input className="input" inputMode="decimal" value={test.total} onChange={(e) => setTest({ ...test, total: Number(e.target.value) || 0 })} />
        </label>
        <label className="mt-2 block">
          <span className="label">{t("Number of deposits")}</span>
          <input className="input" inputMode="numeric" value={test.count} onChange={(e) => setTest({ ...test, count: Number(e.target.value) || 0 })} />
        </label>
        <div className="mt-4 rounded-lg bg-surface p-3 text-center">
          <div className="text-xs text-muted">{t("Score")}</div>
          <div className="text-2xl font-semibold">{result.score}</div>
          <div className="mt-1 text-sm font-medium text-brand-ink">{t(result.tier)}</div>
          <div className="mt-1 text-xs text-muted">{t("Average deposit")} {test.count ? (test.total / test.count).toFixed(0) : 0}</div>
        </div>
      </div>
    </div>
  );
}
