import { ActionForm, Submit } from "@/components/client";
import type { BoxRule } from "@/lib/box-rule";
import type { T } from "@/lib/i18n";
import { saveBoxRule } from "./actions";
import { BoxFields } from "./box-fields";

/** Lucky Box release rules of one promotion on their own (the Lucky Box page). */
export function BoxRuleForm({ id, rule, currency, t }: { id: number; rule: BoxRule | null; currency: string; t: T }) {
  return (
    <ActionForm action={saveBoxRule} close className="space-y-4">
      <input type="hidden" name="id" value={id} />
      <BoxFields rule={rule} currency={currency} />
      <div className="flex justify-end">
        <Submit>{t("Save")}</Submit>
      </div>
    </ActionForm>
  );
}
