"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/components/i18n";

export type NavGroup = { group: string; items: { href: string; label: string }[] };

function NavList({ nav, onPick }: { nav: NavGroup[]; onPick?: () => void }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));
  return (
    <>
      {nav.map((g) => (
        <div key={g.group} className="mb-4">
          <div className="px-2 pb-1 text-[11px] tracking-wider text-[var(--side-muted)] uppercase">{g.group}</div>
          {g.items.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              onClick={onPick}
              className={`block rounded-md px-2 py-1.5 text-sm ${
                isActive(it.href) ? "bg-[var(--side-active-bg)] font-medium text-[var(--side-active-ink)]" : "hover:bg-[var(--side-hover)]"
              }`}
            >
              {it.label}
            </Link>
          ))}
        </div>
      ))}
    </>
  );
}

export function Shell({ nav, brandName, top, children }: { nav: NavGroup[]; brandName: string; top: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const t = useT();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [path]);

  const logo = (
    <Link href="/" className="mb-6 flex items-center gap-2 px-2">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[#2a78d6] text-sm font-bold text-white">
        {brandName.slice(0, 2).toUpperCase()}
      </div>
      <div className="truncate text-sm font-semibold text-[var(--side-title)]">{brandName}</div>
    </Link>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-[var(--side)] text-[var(--side-ink)] lg:block">
        <div className="sticky top-0 max-h-screen overflow-y-auto px-3 py-5">
          {logo}
          <NavList nav={nav} />
        </div>
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button aria-label={t("Close menu")} className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-[var(--side)] px-3 py-5 text-[var(--side-ink)] shadow-xl">
            {logo}
            <NavList nav={nav} onPick={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-4 backdrop-blur lg:px-8">
          <button className="btn btn-ghost btn-sm lg:hidden" onClick={() => setOpen(true)} aria-label={t("Open menu")}>
            ☰
          </button>
          {top}
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
