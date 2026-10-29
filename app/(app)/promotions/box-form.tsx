import { ActionForm, Submit } from "@/components/client";
import { Field } from "@/components/ui";
import { DEFAULT_BOX, type BoxRule } from "@/lib/box-rule";
import type { T } from "@/lib/i18n";
import { saveBoxRule } from "./actions";

/** Lucky Box release rules of one promotion. */
export function BoxRuleForm({ id, rule, currency, t }: { id: number; rule: BoxRule | null; currency: string; t: T }) {
  const r = rule ?? DEFAULT_BOX;
  const v = (x: number) => (x > 0 ? x : "");
  return (
    <ActionForm action={saveBoxRule} close className="space-y-4">
      <input type="hidden" name="id" value={id} />
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={!!rule} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
        <span>
          {t("This is a Lucky Box promotion")}
          <span className="block text-xs text-muted">{t("Winnings go into the player's box and come out when the rule below is met. Untick to stop (the boxes and their history stay).")}</span>
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("Net win on a withdrawal at least ({cur})", { cur: currency })} hint={t("Net win = the withdrawal − deposits since the previous withdrawal. Empty = not needed.")}>
          <input name="minNetWin" className="input" inputMode="decimal" defaultValue={v(r.minNetWin)} placeholder="0" />
        </Field>
        <Field label={t("Deposits since the box filled at least ({cur})", { cur: currency })} hint={t("Counted from when the box filled, or from the last release. Empty = not needed.")}>
          <input name="minDeposit" className="input" inputMode="decimal" defaultValue={v(r.minDeposit)} placeholder="0" />
        </Field>
        <Field label={t("Most per release ({cur})", { cur: currency })} hint={t("Empty = everything in the box comes out at once.")}>
          <input name="releaseCap" className="input" inputMode="decimal" defaultValue={v(r.releaseCap)} placeholder={t("everything")} />
        </Field>
        <Field label={t("Points run out after (days)")} hint={t("Empty = never.")}>
          <input name="expiryDays" className="input" inputMode="numeric" defaultValue={v(r.expiryDays)} placeholder={t("never")} />
        </Field>
      </div>
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" name="notify" defaultChecked={r.notify} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
        <span>
          {t("Tell CS when a box can be released")}
          <span className="block text-xs text-muted">{t("Shows in Follow-up alerts and pops up. With both amounts empty, boxes are released by hand only.")}</span>
        </span>
      </label>
      <div className="flex justify-end">
        <Submit>{t("Save")}</Submit>
      </div>
    </ActionForm>
  );
}
