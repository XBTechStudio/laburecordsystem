"use client";

import { useRef } from "react";
import { useT } from "@/components/i18n";

/** The message sent to the player, with the saved messages from Settings one click away. */
export function MessageField({ templates }: { templates: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const t = useT();
  return (
    <div>
      <div className="flex items-end gap-2">
        <span className="label mr-auto">{t("Message sent")}</span>
        {templates.length > 0 && (
          <select
            className="input mb-1 h-7 w-auto max-w-56 text-xs"
            defaultValue=""
            aria-label={t("Use a saved message")}
            onChange={(e) => {
              if (ref.current && e.target.value) ref.current.value = e.target.value;
              e.target.value = "";
            }}
          >
            <option value="">{t("Use a saved message…")}</option>
            {templates.map((m, i) => (
              <option key={i} value={m}>
                {m.length > 60 ? m.slice(0, 60) + "…" : m}
              </option>
            ))}
          </select>
        )}
      </div>
      <textarea ref={ref} name="message" rows={3} className="input" placeholder={t("What you sent the player (optional)")} maxLength={5000} />
    </div>
  );
}
