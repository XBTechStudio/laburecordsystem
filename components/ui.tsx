import Link from "next/link";
import type { ReactNode } from "react";
import { getT } from "@/lib/i18n-server";

export function PageHeader({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <div className="mr-auto min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {desc && <p className="mt-0.5 text-sm text-ink-2">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  note,
  action,
  children,
  className = "",
  flush = false,
}: {
  title?: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No inner padding, for tables that run edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 ${flush ? "px-4 pt-4 pb-3" : "px-4 pt-4"}`}>
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {note && <span className="text-xs text-muted">{note}</span>}
          {action && <div className="ml-auto text-xs">{action}</div>}
        </div>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

type Tone = "neutral" | "brand" | "good" | "warning" | "critical";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2",
  brand: "bg-brand-soft text-brand-ink",
  good: "bg-good-soft text-good-ink",
  warning: "bg-warning-soft text-warning-ink",
  critical: "bg-critical-soft text-critical-ink",
};

export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`chip ${TONE[tone]}`} title={title}>
      {children}
    </span>
  );
}

export function Notice({ tone = "brand", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`rounded-lg px-3 py-2.5 text-sm ${TONE[tone]}`}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className = "" }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint block">{hint}</span>}
    </label>
  );
}

/** Small ⓘ with an explanation on hover or focus. */
export function Info({ children }: { children: ReactNode }) {
  return (
    <span className="group relative inline-flex align-middle" tabIndex={0}>
      <span className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-[var(--line-strong)] text-[10px] font-semibold text-muted">
        i
      </span>
      <span className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-1.5 w-64 -translate-x-1/2 rounded-lg border border-line bg-surface p-2.5 text-xs font-normal leading-relaxed whitespace-normal text-ink-2 opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100">
        {children}
      </span>
    </span>
  );
}

export function Tabs({ items }: { items: { href: string; label: string; active: boolean; count?: number }[] }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
            t.active ? "border-brand font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"
          }`}
        >
          {t.label}
          {t.count != null && <span className="rounded bg-surface-2 px-1.5 text-xs text-ink-2">{t.count}</span>}
        </Link>
      ))}
    </div>
  );
}

export function Delta({ cur, prev, goodWhenUp = true }: { cur: number; prev: number; goodWhenUp?: boolean }) {
  if (!prev) return <span className="text-xs text-muted">–</span>;
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  const up = p >= 0;
  return (
    <span className={`text-xs font-medium ${up === goodWhenUp ? "text-good-ink" : "text-critical-ink"}`}>
      {up ? "▲" : "▼"} {Math.abs(p).toFixed(1)}%
    </span>
  );
}

export async function Pager({ page, pages, href }: { page: number; pages: number; href: (p: number) => string }) {
  if (pages <= 1) return null;
  const t = await getT();
  return (
    <div className="flex items-center justify-end gap-2 px-4 py-3 text-sm">
      <span className="text-muted">{t("Page {page} of {pages}", { page, pages })}</span>
      {page > 1 ? (
        <Link className="btn btn-sm" href={href(page - 1)}>
          ← {t("Previous")}
        </Link>
      ) : null}
      {page < pages ? (
        <Link className="btn btn-sm" href={href(page + 1)}>
          {t("Next")} →
        </Link>
      ) : null}
    </div>
  );
}
