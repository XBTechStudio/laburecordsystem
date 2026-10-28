import Link from "next/link";
import { PRESETS, type Range } from "@/lib/dates";
import { getT } from "@/lib/i18n-server";

/**
 * Date range picker that works without JavaScript: preset links plus a from/to form.
 * Other query params on the page are kept.
 */
export async function RangeBar({ path, range, params = {} }: { path: string; range: Range & { preset?: string }; params?: Record<string, string | undefined> }) {
  const keep = Object.entries(params).filter(([k, v]) => v && !["from", "to", "preset", "page"].includes(k)) as [string, string][];
  const t = await getT();
  const href = (q: Record<string, string>) => `${path}?${new URLSearchParams([...keep, ...Object.entries(q)])}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex overflow-x-auto rounded-lg border border-line bg-surface-2 p-0.5">
        {PRESETS.map((p) => (
          <Link
            key={p.id}
            href={href({ preset: p.id })}
            className={`rounded-md px-2.5 py-1 text-sm whitespace-nowrap ${
              range.preset === p.id ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-2 hover:text-ink"
            }`}
          >
            {t(p.label)}
          </Link>
        ))}
      </div>
      <form action={path} className="flex items-center gap-1.5">
        {keep.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <input type="date" name="from" defaultValue={range.from} className="input h-8 w-auto" aria-label={t("From")} />
        <span className="text-sm text-muted">{t("to")}</span>
        <input type="date" name="to" defaultValue={range.to} className="input h-8 w-auto" aria-label={t("To")} />
        <button className="btn btn-sm h-8">{t("Apply")}</button>
      </form>
    </div>
  );
}
