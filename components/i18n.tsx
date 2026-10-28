"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LANGS, makeT, type Dict, type Lang } from "@/lib/i18n";

const Ctx = createContext<{ lang: Lang; dict: Dict | null }>({ lang: "en", dict: null });

export function I18nProvider({ lang, dict, children }: { lang: Lang; dict: Dict | null; children: ReactNode }) {
  const value = useMemo(() => ({ lang, dict }), [lang, dict]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT() {
  const { dict } = useContext(Ctx);
  return useMemo(() => makeT(dict), [dict]);
}

export function useLang() {
  return useContext(Ctx).lang;
}

export function LangSwitcher({ action, compact = false }: { action: (lang: string) => Promise<void>; compact?: boolean }) {
  const lang = useLang();
  const router = useRouter();
  const change = async (l: string) => {
    await action(l);
    router.refresh();
  };
  if (compact)
    return (
      <select aria-label="Language" className="input h-8 w-auto" value={lang} onChange={(e) => change(e.target.value)}>
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    );
  return (
    <div className="flex justify-center gap-1 text-sm">
      {LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          onClick={() => change(l.code)}
          className={`rounded-md px-2 py-1 ${l.code === lang ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:text-ink"}`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
