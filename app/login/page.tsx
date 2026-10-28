import { redirect } from "next/navigation";
import { ActionForm, Submit } from "@/components/client";
import { LangSwitcher } from "@/components/i18n";
import { getUser } from "@/lib/auth";
import { getT } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";
import { setLang } from "../lang-action";
import { login } from "./actions";

export default async function LoginPage() {
  if (await getUser()) redirect("/");
  const [s, t] = await Promise.all([getSettings(), getT()]);
  return (
    <main className="grid min-h-screen place-items-center bg-page px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-[#2a78d6] text-sm font-bold text-white">{s.systemName.slice(0, 2).toUpperCase()}</div>
          <div className="text-lg font-semibold">{s.systemName}</div>
        </div>
        <div className="card p-6">
          <h1 className="text-base font-semibold">{t("Sign in")}</h1>
          <p className="mt-0.5 text-sm text-ink-2">{t("Use the account your administrator gave you.")}</p>
          <ActionForm action={login} className="mt-5 space-y-4">
            <label className="block">
              <span className="label">{t("Username")}</span>
              <input name="username" className="input" autoComplete="username" autoFocus required />
            </label>
            <label className="block">
              <span className="label">{t("Password")}</span>
              <input name="password" type="password" className="input" autoComplete="current-password" required />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" name="remember" className="h-4 w-4 accent-[var(--brand)]" />
              {t("Keep me signed in on this device for 30 days")}
            </label>
            <Submit className="btn btn-primary w-full" pending={t("Signing in…")}>
              {t("Sign in")}
            </Submit>
          </ActionForm>
        </div>
        <p className="mt-4 text-center text-xs text-muted">{t("Forgot your password? Ask an administrator to reset it.")}</p>
        <div className="mt-4">
          <LangSwitcher action={setLang} />
        </div>
      </div>
    </main>
  );
}
