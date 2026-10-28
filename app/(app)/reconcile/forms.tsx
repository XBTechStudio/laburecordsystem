import { ActionForm, Submit } from "@/components/client";
import { Field } from "@/components/ui";
import type { T } from "@/lib/i18n";
import { recordBalance, recordMove, recordTransfer, resolveCheck } from "./actions";

type Acc = { id: number; name: string; currency: string };

export function BalanceForm({ acc, t }: { acc: Acc; t: T }) {
  return (
    <ActionForm action={recordBalance} className="space-y-3">
      <input type="hidden" name="channelId" value={acc.id} />
      <Field label={t("Balance shown in the bank / PG now ({cur})", { cur: acc.currency })}>
        <input name="actual" className="input text-lg" inputMode="decimal" required autoFocus placeholder="0.00" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("As at")} hint={t("Leave empty for now")}>
          <input name="time" type="datetime-local" className="input" />
        </Field>
        <Field label={t("Note")}>
          <input name="note" className="input" />
        </Field>
      </div>
      <p className="text-xs text-muted">{t("The system compares it with what this account should hold and shows the difference straight away.")}</p>
      <div className="flex justify-end">
        <Submit>{t("Check balance")}</Submit>
      </div>
    </ActionForm>
  );
}

export function TransferForm({ accounts, t }: { accounts: Acc[]; t: T }) {
  const opts = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name} ({a.currency})
    </option>
  ));
  return (
    <ActionForm action={recordTransfer} close className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("From")}>
          <select name="from" className="input" required>
            {opts}
          </select>
        </Field>
        <Field label={t("To")}>
          <select name="to" className="input" required defaultValue={accounts[1]?.id}>
            {opts}
          </select>
        </Field>
        <Field label={t("Amount")}>
          <input name="amount" className="input" inputMode="decimal" required />
        </Field>
        <Field label={t("Transfer fee")} hint={t("Taken from the sending account")}>
          <input name="fee" className="input" inputMode="decimal" placeholder="0" />
        </Field>
        <Field label={t("When")} hint={t("Leave empty for now")}>
          <input name="time" type="datetime-local" className="input" />
        </Field>
        <Field label={t("Note")}>
          <input name="note" className="input" placeholder={t("e.g. PG settlement to bank")} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Submit>{t("Record transfer")}</Submit>
      </div>
    </ActionForm>
  );
}

export function MoveForm({ accounts, t, allowAdjust, channelId }: { accounts: Acc[]; t: T; allowAdjust: boolean; channelId?: number }) {
  return (
    <ActionForm action={recordMove} close className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Account")}>
          <select name="channelId" className="input" defaultValue={channelId} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("What happened")}>
          <select name="kind" className="input" required>
            <option value="TOPUP">{t("Money put in (top-up, capital)")}</option>
            <option value="CASHOUT">{t("Money taken out (cash-out, owner)")}</option>
            <option value="FEE">{t("Bank / PG charge")}</option>
            {allowAdjust && <option value="ADJUST">{t("Correction (+ or −)")}</option>}
          </select>
        </Field>
        <Field label={t("Amount")} hint={allowAdjust ? t("For a correction, use − to reduce the balance") : undefined}>
          <input name="amount" className="input" inputMode="decimal" required />
        </Field>
        <Field label={t("When")} hint={t("Leave empty for now")}>
          <input name="time" type="datetime-local" className="input" />
        </Field>
      </div>
      <Field label={t("Note")}>
        <input name="note" className="input" />
      </Field>
      <div className="flex justify-end">
        <Submit>{t("Save")}</Submit>
      </div>
    </ActionForm>
  );
}

export function ResolveForm({ id, diff, t }: { id: number; diff: string; t: T }) {
  return (
    <ActionForm action={resolveCheck} close className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <p className="text-sm">{t("Difference: {diff}", { diff })}</p>
      <Field label={t("What explains it?")}>
        <input name="note" className="input" placeholder={t("e.g. withdrawal paid but not entered yet")} />
      </Field>
      <fieldset className="space-y-2 text-sm">
        <label className="flex items-start gap-2">
          <input type="radio" name="mode" value="adjust" defaultChecked className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
          <span>
            {t("Book it as an adjustment")}
            <span className="block text-xs text-muted">{t("The system balance is corrected to match the bank from this point on.")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="mode" value="explain" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
          <span>
            {t("Only mark it as explained")}
            <span className="block text-xs text-muted">{t("Use this when the missing entry will still be added, e.g. a late withdrawal.")}</span>
          </span>
        </label>
      </fieldset>
      <div className="flex justify-end">
        <Submit>{t("Save")}</Submit>
      </div>
    </ActionForm>
  );
}
