import type { ReactNode } from "react";
import { ActionButton, ActionForm, Dialog, Submit } from "@/components/client";
import { Field } from "@/components/ui";
import { toLocalInput } from "@/lib/dates";
import { n } from "@/lib/format";
import type { T } from "@/lib/i18n";
import { deleteEntry, updateEntry } from "./actions";

/** Edit and Delete for one saved entry, or an empty cell when the person isn't allowed to change it. */
export function EditCell({ kind, id, label, allowed, t, children }: { kind: string; id: number; label: string; allowed: boolean; t: T; children: ReactNode }) {
  if (!allowed) return <td />;
  return (
    <td className="r space-x-1 whitespace-nowrap">
      <Dialog label={t("Edit")} title={t("Edit {name}", { name: label })}>
        <ActionForm action={updateEntry} close className="space-y-3">
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="id" value={id} />
          {children}
          <div className="flex justify-end">
            <Submit>{t("Save")}</Submit>
          </div>
        </ActionForm>
      </Dialog>
      <ActionButton action={deleteEntry} fields={{ kind, id }} question={t("Delete this {name}? This can't be undone.", { name: label })}>
        {t("Delete")}
      </ActionButton>
    </td>
  );
}

type TxnLike = { type: string; amount: { toString(): string }; txnAt: Date; channelId: number | null; ref: string | null; note: string | null; payBank: string | null; payAccount: string | null };

/** "DBS · 123-456" — where a withdrawal was paid to. */
export const payTo = (tx: { payBank: string | null; payAccount: string | null }) => [tx.payBank, tx.payAccount].filter(Boolean).join(" · ") || "–";

/** The fields for changing a deposit or withdrawal. */
export function TxnFields({ tx, channels, t }: { tx: TxnLike; channels: { value: string; label: string }[]; t: T }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={t("Type")}>
        <select name="type" className="input" defaultValue={tx.type}>
          <option value="DEPOSIT">{t("Deposit")}</option>
          <option value="WITHDRAW">{t("Withdrawal")}</option>
        </select>
      </Field>
      <Field label={t("Amount")}>
        <input name="amount" className="input" defaultValue={n(tx.amount)} inputMode="decimal" required />
      </Field>
      <Field label={t("Date & time")}>
        <input name="time" type="datetime-local" className="input" defaultValue={toLocalInput(tx.txnAt)} />
      </Field>
      <Field label={t("PG / bank")}>
        <select name="channel" className="input" defaultValue={tx.channelId ?? ""}>
          <option value="">–</option>
          {channels.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("Withdrawal bank")}>
        <input name="payBank" className="input" defaultValue={tx.payBank ?? ""} />
      </Field>
      <Field label={t("Account no.")}>
        <input name="payAccount" className="input" defaultValue={tx.payAccount ?? ""} />
      </Field>
      <Field label={t("Note")}>
        <input name="note" className="input" defaultValue={tx.note ?? ""} />
      </Field>
      <Field label={t("Reference no.")}>
        <input name="ref" className="input" defaultValue={tx.ref ?? ""} />
      </Field>
    </div>
  );
}
