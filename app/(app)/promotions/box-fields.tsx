"use client";

import { useState } from "react";
import { useT } from "@/components/i18n";
import { boxText, DEFAULT_BOX, type BoxRule } from "@/lib/box-rule";

type When = "hand" | "deposit" | "win";

/**
 * Lucky Box settings of one promotion, laid out as plain questions. Posts box=on, minNetWin, minDeposit,
 * releaseCap, expiryDays and notify (fields that don't apply are left out, which reads as 0).
 */
export function BoxFields({ rule, currency }: { rule: BoxRule | null; currency: string }) {
  const t = useT();
  const r0 = rule ?? DEFAULT_BOX;
  const [on, setOn] = useState(!!rule);
  const [when, setWhen] = useState<When>(r0.minNetWin > 0 ? "win" : r0.minDeposit > 0 ? "deposit" : "hand");
  const [netWin, setNetWin] = useState(r0.minNetWin > 0 ? String(r0.minNetWin) : "");
  const [deposit, setDeposit] = useState(r0.minDeposit > 0 ? String(r0.minDeposit) : "");
  const [capOn, setCapOn] = useState(r0.releaseCap > 0);
  const [cap, setCap] = useState(r0.releaseCap > 0 ? String(r0.releaseCap) : "");
  const [expOn, setExpOn] = useState(r0.expiryDays > 0);
  const [days, setDays] = useState(r0.expiryDays > 0 ? String(r0.expiryDays) : "");
  const [notify, setNotify] = useState(r0.notify);

  const n = (s: string) => Math.max(0, Number(s) || 0);
  const now: BoxRule = {
    minNetWin: when === "win" ? n(netWin) : 0,
    minDeposit: when === "hand" ? 0 : n(deposit),
    releaseCap: capOn ? n(cap) : 0,
    expiryDays: expOn ? Math.round(n(days)) : 0,
    notify,
  };
  const cur = { cur: currency };
  const radio = "mt-0.5 h-4 w-4 accent-[var(--brand)]";
  const small = "input h-8 w-28";

  return (
    <fieldset className="space-y-3 rounded-lg border border-line p-3">
      <input type="hidden" name="boxForm" value="1" />
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" name="box" checked={on} onChange={(e) => setOn(e.target.checked)} className={radio} />
        <span>
          <span className="font-medium">{t("Lucky Box")}</span>
          <span className="block text-xs text-muted">
            {t("Tick if the player's winnings from this promotion can't be withdrawn straight away: CS takes them off the player and keeps them in a box, and gives them back once the condition below is met.")}
          </span>
        </span>
      </label>

      {on && (
        <div className="space-y-4 border-t border-line pt-3 text-sm">
          <div className="space-y-2">
            <div className="label">{t("1. When can the box be given back?")}</div>
            <label className="flex items-start gap-2.5">
              <input type="radio" name="boxWhen" checked={when === "hand"} onChange={() => setWhen("hand")} className={radio} />
              <span>
                {t("Only when CS decides")}
                <span className="block text-xs text-muted">{t("The system doesn't check anything; release it by hand on the Lucky Box page.")}</span>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <input type="radio" name="boxWhen" checked={when === "deposit"} onChange={() => setWhen("deposit")} className={radio} />
              <span className="flex-1">
                {t("After the player deposits enough")}
                {when === "deposit" && (
                  <span className="mt-1.5 flex flex-wrap items-center gap-2">
                    {t("Deposits after the box was filled reach ({cur})", cur)}
                    <input name="minDeposit" className={small} inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="300" required />
                  </span>
                )}
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <input type="radio" name="boxWhen" checked={when === "win"} onChange={() => setWhen("win")} className={radio} />
              <span className="flex-1">
                {t("When the player withdraws a win")}
                {when === "win" && (
                  <span className="mt-1.5 block space-y-1.5">
                    <span className="flex flex-wrap items-center gap-2">
                      {t("The withdrawal is more than what they deposited since their last withdrawal by at least ({cur})", cur)}
                      <input name="minNetWin" className={small} inputMode="decimal" value={netWin} onChange={(e) => setNetWin(e.target.value)} placeholder="50" required />
                    </span>
                    <span className="block text-xs text-muted">{t("E.g. deposited 100, withdraws 180 → won 80.")}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      {t("and deposits after the box was filled reach ({cur})", cur)}
                      <input name="minDeposit" className={small} inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder={t("not needed")} />
                    </span>
                  </span>
                )}
              </span>
            </label>
          </div>

          <div className="space-y-2">
            <div className="label">{t("2. How much comes out each time?")}</div>
            <label className="flex items-center gap-2.5">
              <input type="radio" name="boxCap" checked={!capOn} onChange={() => setCapOn(false)} className={radio} />
              {t("Everything in the box")}
            </label>
            <label className="flex flex-wrap items-center gap-2.5">
              <input type="radio" name="boxCap" checked={capOn} onChange={() => setCapOn(true)} className={radio} />
              {t("At most ({cur})", cur)}
              {capOn && <input name="releaseCap" className={small} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="50" required />}
              {capOn && <span className="text-xs text-muted">{t("the rest waits for the next time")}</span>}
            </label>
          </div>

          <div className="space-y-2">
            <div className="label">{t("3. Do the points expire?")}</div>
            <label className="flex items-center gap-2.5">
              <input type="radio" name="boxExp" checked={!expOn} onChange={() => setExpOn(false)} className={radio} />
              {t("They don't expire")}
            </label>
            <label className="flex flex-wrap items-center gap-2.5">
              <input type="radio" name="boxExp" checked={expOn} onChange={() => setExpOn(true)} className={radio} />
              {t("Yes, if not given back within")}
              {expOn && <input name="expiryDays" className="input h-8 w-20" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} placeholder="30" required />}
              {expOn && t("days")}
            </label>
          </div>

          {when !== "hand" && (
            <label className="flex items-start gap-2.5">
              <input type="checkbox" name="notify" checked={notify} onChange={(e) => setNotify(e.target.checked)} className={radio} />
              <span>
                {t("Tell CS when a box can be given back")}
                <span className="block text-xs text-muted">{t("Shows in Follow-up alerts and pops up.")}</span>
              </span>
            </label>
          )}

          <div className="rounded-md bg-surface-2 px-3 py-2 text-xs text-ink-2">
            <span className="font-medium">{t("In short:")}</span> {boxText(now, t, currency)}
          </div>
        </div>
      )}
      {!on && rule && <p className="text-xs text-muted">{t("Unticking stops the Lucky Box; boxes and their history stay.")}</p>}
    </fieldset>
  );
}
