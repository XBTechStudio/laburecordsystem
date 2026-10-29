import Link from "next/link";
import { ActionButton, ActionForm, Dialog, Submit } from "@/components/client";
import { Card, Chip, Field, PageHeader, TableWrap, Tabs } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { n } from "@/lib/format";
import { tk, type T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";
import { saveAlerts, saveChannel, saveFollowUp, saveGeneral, saveRules, saveTiers, toggleChannel } from "./actions";
import { TierEditor } from "./tier-editor";

const TABS = [
  ["general", tk("General")],
  ["tiers", tk("Player tiers")],
  ["followup", tk("Churn & CS")],
  ["alerts", tk("Alerts")],
  ["rules", tk("Promotions & reconciliation")],
  ["channels", tk("PG & bank channels")],
] as const;

const WEEKDAYS = [tk("Monday"), tk("Tuesday"), tk("Wednesday"), tk("Thursday"), tk("Friday"), tk("Saturday"), tk("Sunday")];

function Check({ name, label, hint, on, disabled }: { name: string; label: string; hint?: string; on: boolean; disabled: boolean }) {
  return (
    <label className="flex items-start gap-2.5 text-sm">
      <input type="checkbox" name={name} defaultChecked={on} disabled={disabled} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requirePage("settings");
  const ro = !can(user, "settings", 3);
  const want = (await searchParams).tab;
  const tab = TABS.find(([k]) => k === want)?.[0] ?? "general";
  const [s, t] = await Promise.all([getSettings(), getT()]);
  const roles = tab === "alerts" ? await prisma.role.findMany({ orderBy: { name: "asc" } }) : [];
  const channels = tab === "channels" ? await prisma.payChannel.findMany({ orderBy: [{ active: "desc" }, { type: "asc" }, { name: "asc" }] }) : [];
  const save = (label = t("Save")) => !ro && <Submit>{label}</Submit>;

  return (
    <div className="max-w-5xl">
      <PageHeader title={t("Settings")} desc={ro ? t("You can view these settings but not change them.") : t("Rules the analysis uses. Changes apply straight away to every page.")} />
      <Tabs items={TABS.map(([k, label]) => ({ href: `/admin/settings?tab=${k}`, label: t(label), active: tab === k }))} />

      {tab === "general" && (
        <Card>
          <ActionForm action={saveGeneral} className="max-w-xl space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("System name")} hint={t("Shown in the menu and on the sign-in page.")}>
                <input name="systemName" className="input" defaultValue={s.systemName} disabled={ro} />
              </Field>
              <Field label={t("Base currency")} hint={t("Totals across brands are shown in this currency.")}>
                <input name="baseCurrency" className="input uppercase" defaultValue={s.baseCurrency} maxLength={3} disabled={ro} />
              </Field>
            </div>
            <Field
              label={t("Staff may fix their own entries for (minutes)")}
              hint={t("0 = never: only roles with Full access (by default the Administrator) can change or delete saved data. Every change is kept in the audit log.")}
            >
              <input name="selfFixMinutes" className="input w-32" inputMode="numeric" defaultValue={s.selfFixMinutes} disabled={ro} />
            </Field>
            <fieldset className="space-y-2.5">
              <legend className="label">{t("Data entry")}</legend>
              <Check name="pickTime" label={t("Staff may enter the date & time of deposits, withdrawals and claims")} hint={t("Off = every row gets the time it is saved.")} on={s.entry.pickTime} disabled={ro} />
              <Check name="carryBrand" label={t("A brand picked on a row fills the empty rows below")} hint={t("Off = every row starts empty and staff pick its brand.")} on={s.entry.carryBrand} disabled={ro} />
            </fieldset>
            <fieldset className="space-y-2.5">
              <legend className="label">{t("Net profit = Win/Loss …")}</legend>
              <Check name="fees" label={"− " + t("PG and bank fees")} hint={t("Worked out from each PG/bank's fee rate on deposits")} on={s.profit.fees} disabled={ro} />
              <Check name="promos" label={"− " + t("Promotions given")} hint={t("From promotion claims")} on={s.profit.promos} disabled={ro} />
              <Check name="expenses" label={"− " + t("Expenses")} hint={t("Salary, advertising and your other expense categories")} on={s.profit.expenses} disabled={ro} />
              <Check name="income" label={"+ " + t("Other income")} hint={t("Income categories, e.g. provider rebates")} on={s.profit.income} disabled={ro} />
            </fieldset>
            {save()}
          </ActionForm>
        </Card>
      )}

      {tab === "tiers" && (
        <Card title={t("How players are graded")} note={t("Based on each player's lifetime deposits")}>
          <ActionForm action={saveTiers}>
            <TierEditor initial={s.tierScoring} readOnly={ro} />
            <div className="mt-5">{save(t("Save tier rules"))}</div>
          </ActionForm>
        </Card>
      )}

      {tab === "followup" && (
        <Card>
          <ActionForm action={saveFollowUp} className="max-w-xl space-y-4">
            <Field label={t("Churn thresholds (days without a deposit)")} hint={t("Comma separated. Each becomes a tab on the Churn follow-up page, e.g. 7, 15, 30.")}>
              <input name="churnDays" className="input" defaultValue={s.churnDays.join(", ")} disabled={ro} />
            </Field>
            <Field label={t("Return window (days)")} hint={t("A contacted player who deposits within this many days counts as returned for that CS.")}>
              <input name="recallDays" className="input w-32" inputMode="numeric" defaultValue={s.recallDays} disabled={ro} />
            </Field>
            <Field label={t("Contact channels")} hint={t("One per line. CS pick from this list when they log a contact.")}>
              <textarea name="csChannels" rows={5} className="input" defaultValue={s.csChannels.join("\n")} disabled={ro} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("Follow up again after (days)")} hint={t("Contacted this many days ago and still no deposit: CS get a reminder. 0 = off.")}>
                <input name="refollowDays" className="input w-32" inputMode="numeric" defaultValue={s.refollowDays} disabled={ro} />
              </Field>
              <Field label={t("Counts as recalled from (deposit)")} hint={t("A deposit after a contact counts as a successful recall from this amount. 0 = any deposit.")}>
                <input name="recallMinAmount" className="input w-32" inputMode="decimal" defaultValue={s.recallMinAmount} disabled={ro} />
              </Field>
            </div>
            <Field label={t("Saved messages")} hint={t("Messages CS can pick when logging a contact. Leave an empty line between messages.")}>
              <textarea name="csTemplates" rows={6} className="input" defaultValue={s.csTemplates.join("\n\n")} disabled={ro} />
            </Field>
            {save()}
          </ActionForm>
        </Card>
      )}

      {tab === "alerts" && (
        <Card>
          <ActionForm action={saveAlerts} className="max-w-2xl space-y-5">
            <p className="text-sm text-ink-2">
              {t("How tracked promotions count days and weeks, and who gets told. Each promotion's own conditions, reminder level and claim deadline are set on the Promotions page.")}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("A business day starts at")} hint={t("0 = midnight. Daily promotions reset at this hour.")}>
                <select name="dayStartHour" className="input w-32" defaultValue={s.alerts.dayStartHour} disabled={ro}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("A week starts on")}>
                <select name="weekStartDay" className="input w-40" defaultValue={s.alerts.weekStartDay} disabled={ro}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i + 1}>
                      {t(d)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <fieldset className="space-y-2">
              <legend className="label">{t("When a player is close to several promotions")}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="notify" value="nearest" defaultChecked={s.alerts.notify === "nearest"} disabled={ro} className="accent-[var(--brand)]" />
                {t("Only alert the one they are closest to")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="notify" value="all" defaultChecked={s.alerts.notify === "all"} disabled={ro} className="accent-[var(--brand)]" />
                {t("Alert every promotion they are close to")}
              </label>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="label">{t("Who gets the alert")}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="target" value="owner" defaultChecked={s.alerts.target === "owner"} disabled={ro} className="accent-[var(--brand)]" />
                {t("The player's CS (everyone on the brand if the player has no CS yet)")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="target" value="team" defaultChecked={s.alerts.target === "team"} disabled={ro} className="accent-[var(--brand)]" />
                {t("Everyone on the brand")}
              </label>
            </fieldset>
            <fieldset>
              <legend className="label">{t("Roles that receive alerts")}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                {roles.map((r) => (
                  <label key={r.id} className="flex items-center gap-2">
                    <input type="checkbox" name="roleId" value={r.id} defaultChecked={s.alerts.roleIds.includes(r.id)} disabled={ro} className="h-4 w-4 accent-[var(--brand)]" />
                    {t(r.name)}
                  </label>
                ))}
              </div>
              <span className="hint block">{t("Tick none for every role that can act on follow-up alerts (Staff & roles).")}</span>
            </fieldset>
            <div className="space-y-2.5">
              <Check name="popup" label={t("Pop up new alerts on screen")} on={s.alerts.popup} disabled={ro} />
              <Check name="sound" label={t("Play a sound with new alerts")} on={s.alerts.sound} disabled={ro} />
              <Check name="recall" label={t("Tell the CS when a player they contacted deposits again")} on={s.alerts.recall} disabled={ro} />
            </div>
            <Field label={t("Check for new alerts every (seconds)")}>
              <input name="pollSeconds" className="input w-32" inputMode="numeric" defaultValue={s.alerts.pollSeconds} disabled={ro} />
            </Field>
            {save()}
          </ActionForm>
        </Card>
      )}

      {tab === "rules" && (
        <Card>
          <ActionForm action={saveRules} className="max-w-xl space-y-4">
            <Field
              label={t("Promotion effect window (days)")}
              hint={t("A claimer's deposits and withdrawals count towards a promotion from their first claim until this many days after their last claim.")}
            >
              <input name="promoWindowDays" className="input w-32" inputMode="numeric" defaultValue={s.promoWindowDays} disabled={ro} />
            </Field>
            <Field
              label={t("Promotion cost threshold (%)")}
              hint={t("If a promotion gives away more than this % of what its claimers deposit, it's marked “Adjust”. Promotions that lose money are marked “Cancel”.")}
            >
              <input name="promoAdjustPercent" className="input w-32" inputMode="decimal" defaultValue={s.promoAdjustPercent} disabled={ro} />
            </Field>
            <Field label={t("Reconciliation tolerance")} hint={t("Balance differences up to this amount count as matched (rounding, small charges).")}>
              <input name="reconTolerance" className="input w-32" inputMode="decimal" defaultValue={s.reconTolerance} disabled={ro} />
            </Field>
            <Field
              label={t("Statement match: time window (minutes)")}
              hint={t("A line on a PG / bank statement and a recorded deposit or withdrawal with exactly the same amount count as the same when their times are this close.")}
            >
              <input name="statementMinutes" className="input w-32" inputMode="numeric" defaultValue={s.statementMinutes} disabled={ro} />
            </Field>
            {save()}
          </ActionForm>
        </Card>
      )}

      {tab === "channels" && (
        <Card
          flush
          title={t("Payment gateways and bank accounts")}
          note={t("Pick these when entering transactions. Fees come from each account's rate; balances are checked under PG / bank reconciliation.")}
          action={
            !ro && (
              <Dialog label={"+ " + t("Add channel")} title={t("Add PG or bank")} className="btn btn-primary btn-sm">
                <ChannelForm t={t} base={s.baseCurrency} />
              </Dialog>
            )
          }
        >
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Name")}</th>
                  <th>{t("Type")}</th>
                  <th>{t("Currency")}</th>
                  <th className="r">{t("Fee %")}</th>
                  <th className="r">{t("Fixed fee / txn")}</th>
                  <th>{t("Status")}</th>
                  {!ro && <th />}
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id} className={c.active ? "" : "opacity-60"}>
                    <td className="font-medium">{c.name}</td>
                    <td>{c.type === "PG" ? t("Payment gateway") : t("Bank")}</td>
                    <td>{c.currency}</td>
                    <td className="r">{n(c.feePercent)}%</td>
                    <td className="r">{n(c.feeFixed).toFixed(2)}</td>
                    <td>{c.active ? <Chip tone="good">{t("Active")}</Chip> : <Chip>{t("Inactive")}</Chip>}</td>
                    {!ro && (
                      <td className="r space-x-1">
                        <Dialog label={t("Edit")} title={t("Edit {name}", { name: c.name })}>
                          <ChannelForm t={t} base={s.baseCurrency} c={{ id: c.id, name: c.name, type: c.type, currency: c.currency, feePercent: n(c.feePercent), feeFixed: n(c.feeFixed) }} />
                        </Dialog>
                        <ActionButton action={toggleChannel} fields={{ id: c.id }}>
                          {c.active ? t("Deactivate") : t("Reactivate")}
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
                {channels.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-ink-2">
                      {t("No channels yet. Add each payment gateway and bank account you use.")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <p className="mt-6 text-xs text-muted">
        {t("Expense and income categories are managed on the Expenses page. Dividend rules are set per brand under Dividends.")}{" "}
        <Link className="link" href="/expenses?tab=categories">
          {t("Expenses")}
        </Link>{" "}
        ·{" "}
        <Link className="link" href="/dividends?tab=rules">
          {t("Dividends")}
        </Link>
      </p>
    </div>
  );
}

function ChannelForm({ c, t, base }: { c?: { id: number; name: string; type: string; currency: string; feePercent: number; feeFixed: number }; t: T; base: string }) {
  return (
    <ActionForm action={saveChannel} close className="space-y-3">
      {c && <input type="hidden" name="id" value={c.id} />}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Name")}>
          <input name="name" className="input" defaultValue={c?.name} required placeholder={t("e.g. FPay, Maybank 1234")} />
        </Field>
        <Field label={t("Type")}>
          <select name="type" className="input" defaultValue={c?.type ?? "PG"}>
            <option value="PG">{t("Payment gateway")}</option>
            <option value="BANK">{t("Bank account")}</option>
          </select>
        </Field>
        <Field label={t("Fee %")} hint={t("Of each deposit")}>
          <input name="feePercent" className="input" inputMode="decimal" defaultValue={c?.feePercent ?? 0} />
        </Field>
        <Field label={t("Fixed fee per deposit")}>
          <input name="feeFixed" className="input" inputMode="decimal" defaultValue={c?.feeFixed ?? 0} />
        </Field>
        <Field label={t("Currency")}>
          <input name="currency" className="input uppercase" defaultValue={c?.currency ?? base} maxLength={3} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Submit>{t("Save")}</Submit>
      </div>
    </ActionForm>
  );
}
