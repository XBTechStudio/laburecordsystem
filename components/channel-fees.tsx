"use client";

import { useState } from "react";
import { Field } from "@/components/ui";
import { useT } from "@/components/i18n";
import { isPg } from "@/lib/channel-type";

/** Type, and the fees a payment gateway charges. Banks hide the fees; saving a bank clears them. */
export function ChannelFeeFields({
  type,
  feePercent,
  feeFixed,
  wdFeePercent,
  settleFeePercent,
  settleFeeFixed,
  feeAtSettlement,
}: {
  type: string;
  feePercent: number;
  feeFixed: number;
  wdFeePercent: number;
  settleFeePercent: number;
  settleFeeFixed: number;
  /** Account page only: whether the deposit fee is taken when the PG pays out, instead of on each deposit. */
  feeAtSettlement?: boolean;
}) {
  const t = useT();
  const [kind, setKind] = useState(type);
  const pg = isPg(kind);
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={t("Type")}>
        <select name="type" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="BANK">{t("Bank")}</option>
          <option value="PG_OFFLINE">{t("Offline PG")}</option>
          <option value="PG">{t("Online PG")}</option>
        </select>
      </Field>
      {pg && (
        <>
          <Field label={t("Fee %")} hint={t("Of each deposit")}>
            <input name="feePercent" className="input" inputMode="decimal" defaultValue={feePercent} />
          </Field>
          <Field label={t("Fixed fee per deposit")}>
            <input name="feeFixed" className="input" inputMode="decimal" defaultValue={feeFixed} />
          </Field>
          <Field label={t("Withdrawal fee %")} hint={t("Of each withdrawal, taken when it is paid")}>
            <input name="wdFeePercent" className="input" inputMode="decimal" defaultValue={wdFeePercent} />
          </Field>
          <Field label={t("Settlement fee %")} hint={t("Of each settlement. Leave the fee box empty on a transfer and this rate is used.")}>
            <input name="settleFeePercent" className="input" inputMode="decimal" defaultValue={settleFeePercent} />
          </Field>
          <Field label={t("Settlement fixed fee")} hint={t("Added on each settlement, on top of the %.")}>
            <input name="settleFeeFixed" className="input" inputMode="decimal" defaultValue={settleFeeFixed} />
          </Field>
          {feeAtSettlement !== undefined && (
            <label className="col-span-2 flex items-start gap-2 text-sm">
              <input type="checkbox" name="feeAtSettlement" defaultChecked={feeAtSettlement} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
              <span>
                {t("Fee is taken when the PG pays out")}
                <span className="block text-xs text-muted">{t("Tick this if the PG balance goes up by the full deposit. Record the fee in “Transfer / settlement fee” when you record the settlement.")}</span>
              </span>
            </label>
          )}
        </>
      )}
    </div>
  );
}
