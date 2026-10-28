import Link from "next/link";
import { Tabs } from "@/components/ui";
import { addDays, todayStr } from "@/lib/dates";
import { dt } from "@/lib/format";
import { tk, type T } from "@/lib/i18n";
import type { AccountDay } from "@/lib/statements";

export function ReconcileTabs({ active, t }: { active: "balances" | "statements"; t: T }) {
  return (
    <Tabs
      items={[
        { href: "/reconcile", label: t("Balances"), active: active === "balances" },
        { href: "/reconcile/statements", label: t("Statement match"), active: active === "statements" },
      ]}
    />
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day asked for in the address, or today. Never a future day. */
export function pickDay(v: string | undefined) {
  const today = todayStr();
  return v && DAY.test(v) && v <= today ? v : today;
}

export function DayPicker({ path, day, t }: { path: string; day: string; t: T }) {
  const today = todayStr();
  return (
    <form action={path} className="flex items-center gap-1.5">
      <Link className="btn btn-sm h-8" href={`${path}?day=${addDays(day, -1)}`} aria-label={t("Previous day")}>
        ←
      </Link>
      <input type="date" name="day" defaultValue={day} max={today} className="input h-8 w-auto" aria-label={t("Day")} />
      {day < today ? (
        <Link className="btn btn-sm h-8" href={`${path}?day=${addDays(day, 1)}`} aria-label={t("Next day")}>
          →
        </Link>
      ) : null}
      <button className="btn btn-sm h-8">{t("Show")}</button>
      {day !== today && (
        <Link className="btn btn-ghost btn-sm h-8" href={`${path}?day=${today}`}>
          {t("Today")}
        </Link>
      )}
    </form>
  );
}

/** "5 min ago" for a recent read; the date and time for an older one. */
export function readAgo(d: Date | null, t: T) {
  if (!d) return t("never");
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return t("just now");
  if (min < 60) return t("{n} min ago", { n: min });
  if (min < 24 * 60) return t("{n} h ago", { n: Math.floor(min / 60) });
  return dt(d);
}

/** Time of day in Malaysia/Singapore time, to sit next to the statement's own times. */
export function clock(d: Date) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(11, 19);
}

export function statementStatus(acc: { statementError: string | null }, d: AccountDay | undefined) {
  if (!d?.statement) return acc.statementError ? { tone: "critical" as const, label: tk("Can't read the link") } : { tone: "warning" as const, label: tk("Not read yet") };
  if (d.open === 0) {
    const nothing = !d.match?.pairs.length && !d.match?.reversed.length;
    return nothing ? { tone: "neutral" as const, label: tk("Nothing that day") } : { tone: "good" as const, label: tk("All matched") };
  }
  if (d.statement.checkedBy) return { tone: "good" as const, label: tk("Checked") };
  return { tone: "critical" as const, label: tk("Doesn't match") };
}
