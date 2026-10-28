import { ActionButton, ActionForm, Submit } from "@/components/client";
import { Card, Field, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { dt } from "@/lib/format";
import type { T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { changePassword, endSession } from "./actions";

export default async function AccountPage() {
  const user = await requireUser();
  const t = await getT();
  const sessions = await prisma.session.findMany({ where: { userId: user.id, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: "desc" } });
  return (
    <div className="max-w-3xl">
      <PageHeader title={t("My account")} desc={`${user.name} · ${t(user.roleName)} · @${user.username}`} />
      <div className="grid gap-5 md:grid-cols-2">
        <Card title={t("Change password")}>
          <ActionForm action={changePassword} reset className="space-y-3">
            <Field label={t("Current password")}>
              <input name="current" type="password" className="input" required autoComplete="current-password" />
            </Field>
            <Field label={t("New password")} hint={t("At least 8 characters.")}>
              <input name="next" type="password" className="input" required minLength={8} autoComplete="new-password" />
            </Field>
            <Field label={t("Repeat new password")}>
              <input name="repeat" type="password" className="input" required minLength={8} autoComplete="new-password" />
            </Field>
            <Submit>{t("Change password")}</Submit>
          </ActionForm>
        </Card>
        <Card title={t("Where you're signed in")} note={t("Sign out devices you don't recognise")}>
          <ul className="divide-y divide-[var(--line)] text-sm">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-2.5 first:pt-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate">{describeAgent(s.userAgent, t)}</div>
                  <div className="text-xs text-muted">
                    {s.ip} · {t("last active")} {dt(s.lastSeenAt)}
                  </div>
                </div>
                {s.id === user.sessionId ? (
                  <span className="chip bg-good-soft text-good-ink">{t("This device")}</span>
                ) : (
                  <ActionButton action={endSession} fields={{ id: s.id }}>
                    {t("Sign out")}
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function describeAgent(ua: string | null, t: T) {
  if (!ua) return t("Unknown device");
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : t("Device");
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : t("Browser");
  return t("{browser} on {os}", { browser: br, os });
}
