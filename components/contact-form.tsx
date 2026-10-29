import { ActionForm, Submit } from "@/components/client";
import { MessageField } from "@/components/message-field";
import { Field } from "@/components/ui";
import { logContact } from "@/app/(app)/cs/actions";
import { getT } from "@/lib/i18n-server";

/** Log a CS contact for one player. `who` shows a warning when someone else is already following them. */
export async function ContactForm({
  playerId,
  channels,
  promos,
  who,
  templates = [],
  promotionId,
}: {
  playerId: number;
  channels: string[];
  promos: { id: number; name: string }[];
  who?: { name: string; when: string } | null;
  templates?: string[];
  /** Offer preselected, e.g. when following up an alert about it. */
  promotionId?: number | null;
}) {
  const t = await getT();
  return (
    <ActionForm action={logContact} close className="space-y-3">
      <input type="hidden" name="playerId" value={playerId} />
      {who && (
        <div className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-ink">
          {t("{name} contacted this player {when}. Check with them first so the player isn't contacted twice.", { name: who.name, when: who.when })}
          <label className="mt-1 flex items-center gap-2">
            <input type="checkbox" name="confirmDup" className="h-4 w-4" /> {t("Contact anyway")}
          </label>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Channel")}>
          <select name="channel" className="input" required>
            {channels.map((c) => (
              <option key={c} value={c}>
                {t(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("When")} hint={t("Leave empty for now")}>
          <input name="time" type="datetime-local" className="input" />
        </Field>
        <Field label={t("Offer used")}>
          <select name="promotionId" className="input" defaultValue={promotionId ?? ""}>
            <option value="">{t("None")}</option>
            {promos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Bonus given")}>
          <input name="bonus" className="input" inputMode="decimal" placeholder="0" />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="replied" className="h-4 w-4 accent-[var(--brand)]" /> {t("Player replied")}
      </label>
      <MessageField templates={templates} />
      <Field label={t("Result / note")}>
        <input name="result" className="input" placeholder={t("e.g. Will deposit this weekend")} maxLength={250} />
      </Field>
      <div className="flex justify-end">
        <Submit>{t("Log contact")}</Submit>
      </div>
    </ActionForm>
  );
}
