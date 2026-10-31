"use client";

import { useState, type ReactNode } from "react";
import { ActionForm, Submit } from "@/components/client";
import { useT } from "@/components/i18n";
import { recordExchange } from "./actions";

type Acc = { id: number; name: string; currency: string };

function F({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

const fmt = new Intl.NumberFormat("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Selling to or buying from a money changer: the other side's amount is worked out from the rate as you type. */
export function ExchangeForm({ accounts, channelId, parties }: { accounts: Acc[]; channelId?: number; parties: string[] }) {
  const t = useT();
  const [acc, setAcc] = useState(channelId ?? accounts[0]?.id);
  const [dir, setDir] = useState<"OUT" | "IN">("OUT");
  const [amt, setAmt] = useState("");
  const [rate, setRate] = useState("");
  const [otherId, setOtherId] = useState("");
  const [otherCur, setOtherCur] = useState("USDT");
  const cur = accounts.find((a) => a.id === Number(acc))?.currency ?? "";
  const other = accounts.find((a) => a.id === Number(otherId));
  const oc = other?.currency ?? otherCur.toUpperCase();
  const a = Number(amt.replace(/,/g, ""));
  const r = Number(rate.replace(/,/g, ""));
  const result = a > 0 && r > 0 ? a / r : null;

  return (
    <ActionForm action={recordExchange} close className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <F label={t("Account")}>
          <select name="channelId" className="input" value={acc} onChange={(e) => setAcc(Number(e.target.value))} required>
            {accounts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.currency})
              </option>
            ))}
          </select>
        </F>
        <F label={t("What happened")}>
          <select name="dir" className="input" value={dir} onChange={(e) => setDir(e.target.value as "OUT" | "IN")}>
            <option value="OUT">{t("Sold to money changer (money goes out)")}</option>
            <option value="IN">{t("Bought from money changer (money comes in)")}</option>
          </select>
        </F>
        <F label={t("Money changer")}>
          <input name="party" className="input" list="dl-changers" required placeholder={t("e.g. Ah Seng")} />
          <datalist id="dl-changers">
            {parties.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </F>
        <F label={t("Amount ({cur})", { cur })}>
          <input name="amount" className="input" inputMode="decimal" required value={amt} onChange={(e) => setAmt(e.target.value)} />
        </F>
        <F label={t("Other currency")} hint={other ? t("Set by the account below") : undefined}>
          <input name="otherCurrency" className="input" value={oc} onChange={(e) => setOtherCur(e.target.value)} disabled={!!other} required={!other} />
        </F>
        <F label={t("Rate: 1 {other} = ? {cur}", { other: oc || "…", cur })}>
          <input name="rate" className="input" inputMode="decimal" required value={rate} onChange={(e) => setRate(e.target.value)} placeholder="1.30" />
        </F>
      </div>
      <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
        {result != null ? (
          <>
            {dir === "OUT" ? t("Money changer gives") : t("Money changer gets")}: <b className="tabular-nums">{fmt.format(result)}</b> {oc}
          </>
        ) : (
          <span className="text-muted">{t("Enter the amount and rate to see the converted amount.")}</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <F
          label={dir === "OUT" ? t("{cur} received into", { cur: oc || "…" }) : t("{cur} paid from", { cur: oc || "…" })}
          hint={t("Optional: one of our accounts, so its balance moves too")}
        >
          <select name="otherId" className="input" value={otherId} onChange={(e) => setOtherId(e.target.value)}>
            <option value="">{t("Not one of our accounts")}</option>
            {accounts
              .filter((x) => x.id !== Number(acc))
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.currency})
                </option>
              ))}
          </select>
        </F>
        <F label={t("When")} hint={t("Leave empty for now")}>
          <input name="time" type="datetime-local" className="input" />
        </F>
      </div>
      <F label={t("Note")}>
        <input name="note" className="input" />
      </F>
      <div className="flex justify-end">
        <Submit>{t("Save")}</Submit>
      </div>
    </ActionForm>
  );
}
