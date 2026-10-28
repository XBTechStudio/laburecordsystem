import Link from "next/link";
import { BrandSwitcher, ThemeToggle } from "@/components/client";
import { LangSwitcher } from "@/components/i18n";
import { Shell, type NavGroup } from "@/components/shell";
import { can, requireUser } from "@/lib/auth";
import { tk } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { MODULES, type Module } from "@/lib/perms";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { setLang } from "../lang-action";
import { logout, setBrand } from "./shell-actions";

const GROUPS: { group: string; modules: Module[] }[] = [
  { group: tk("Overview"), modules: ["dashboard"] },
  { group: tk("Data"), modules: ["entry", "import", "transactions"] },
  { group: tk("Analysis"), modules: ["reports", "players", "churn", "promotions", "cs"] },
  { group: tk("Finance"), modules: ["reconcile", "expenses", "dividends"] },
  { group: tk("Admin"), modules: ["brands", "users", "audit", "settings"] },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [settings, scope, t] = await Promise.all([getSettings(), getScope(user), getT()]);

  const nav: NavGroup[] = GROUPS.map((g) => ({
    group: t(g.group),
    items: g.modules
      .filter((m) => can(user, m))
      .map((m) => {
        const mod = MODULES.find((x) => x.key === m)!;
        return { href: mod.href, label: t(mod.label) };
      }),
  })).filter((g) => g.items.length);

  const top = (
    <>
      <BrandSwitcher brands={scope.brands.map((b) => ({ id: b.id, name: b.name }))} current={scope.current?.id ?? null} action={setBrand} />
      {scope.current && scope.current.currency !== settings.baseCurrency && <span className="chip bg-surface-2 text-ink-2">{scope.current.currency}</span>}
      <div className="ml-auto flex items-center gap-1">
        <div className="hidden sm:block">
          <LangSwitcher action={setLang} compact />
        </div>
        <ThemeToggle />
        <details className="relative">
          <summary className="btn btn-ghost btn-sm list-none">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">{user.name.slice(0, 1).toUpperCase()}</span>
            <span className="hidden sm:inline">{user.name}</span>
          </summary>
          <div className="absolute right-0 z-30 mt-1 w-60 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
            <div className="px-2.5 py-2">
              <div className="text-sm font-medium">{user.name}</div>
              <div className="text-xs text-muted">
                {t(user.roleName)} · @{user.username}
              </div>
            </div>
            <div className="px-2.5 pb-2 sm:hidden">
              <LangSwitcher action={setLang} compact />
            </div>
            <Link href="/account" className="block rounded-md px-2.5 py-1.5 text-sm hover:bg-surface-2">
              {t("My account & password")}
            </Link>
            <form action={logout}>
              <button className="w-full rounded-md px-2.5 py-1.5 text-left text-sm text-critical-ink hover:bg-surface-2">{t("Log out")}</button>
            </form>
          </div>
        </details>
      </div>
    </>
  );

  return (
    <Shell nav={nav} brandName={settings.systemName} top={top}>
      {scope.brands.length === 0 && (
        <div className="mb-5 rounded-xl border border-line bg-surface p-4 text-sm">
          <div className="font-semibold">{t("No brands yet")}</div>
          <p className="mt-0.5 text-ink-2">
            {can(user, "brands", 3) ? (
              <>
                {t("Start by adding your first brand in")}{" "}
                <Link className="link" href="/admin/brands">
                  {t("Brands")}
                </Link>
                . {t("Everything else is organised by brand.")}
              </>
            ) : (
              t("You haven't been given access to any brand yet. Please ask your administrator.")
            )}
          </p>
        </div>
      )}
      {children}
    </Shell>
  );
}
