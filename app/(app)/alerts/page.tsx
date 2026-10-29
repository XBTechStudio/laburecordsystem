import Link from "next/link";
import type { AlertKind, Prisma } from "@prisma/client";
import { ActionButton, AutoSelect, Dialog } from "@/components/client";
import { ContactForm } from "@/components/contact-form";
import { Card, Chip, Empty, Info, PageHeader, Pager, TableWrap, Tabs } from "@/components/ui";
import { alertText, KIND_LABEL, KIND_TONE, when, type AlertKindName } from "@/lib/alert-text";
import { alertScope, getsAlerts } from "@/lib/alerts";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { count, money } from "@/lib/format";
import { tk } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { alertTick } from "@/lib/promo-engine";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { assignAlert, claimAlert, dismissAlert, releaseAlert } from "./actions";

const PER_PAGE = 50;
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000);
const KINDS = Object.keys(KIND_LABEL) as AlertKindName[];
const OUTCOME: Record<string, string> = { contacted: tk("Contacted"), claimed: tk("Claimed"), released: tk("Released"), dismissed: tk("Dismissed"), auto: tk("Closed by the system") };

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("alerts");
  const sp = await searchParams;
  await alertTick();
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const full = can(user, "alerts", 3);
  const act = can(user, "alerts", 2);
  const tab = sp.tab === "done" ? "done" : "open";
  const who = full && sp.who === "all" ? "all" : "mine";
  const kind = KINDS.find((k) => k === sp.kind);
  const page = Math.max(1, Number(sp.page) || 1);

  const base: Prisma.AlertWhereInput = alertScope(user, settings, scope.brandIds, who);
  const where: Prisma.AlertWhereInput = {
    ...base,
    ...(kind ? { kind: kind as AlertKind } : {}),
    ...(tab === "open" ? { doneAt: null } : { doneAt: { not: null, gte: daysAgo(14) } }),
  };
  const [rows, total, byKind, promos, staff] = await Promise.all([
    prisma.alert.findMany({
      where,
      include: { player: { include: { assignedTo: { select: { name: true } } } }, doneBy: { select: { name: true } } },
      orderBy: tab === "open" ? { raisedAt: "desc" } : { doneAt: "desc" },
      take: PER_PAGE,
      skip: (page - 1) * PER_PAGE,
    }),
    prisma.alert.count({ where }),
    prisma.alert.groupBy({ by: ["kind"], where: { ...base, doneAt: null }, _count: true }),
    prisma.promotion.findMany({ where: { brandId: { in: scope.brandIds }, active: true }, select: { id: true, name: true, brandId: true }, orderBy: { name: "asc" } }),
    full ? prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
  ]);
  const openCount = (k?: string) => byKind.filter((b) => !k || b.kind === k).reduce((a, b) => a + b._count, 0);
  const staffName = new Map(staff.map((s) => [s.id, s.name]));
  const params = Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "page")) as Record<string, string>;
  const href = (q: Record<string, string>) => `/alerts?${new URLSearchParams({ ...params, ...q })}`;
  const focus = Number(sp.focus) || 0;
  const multi = !scope.current;

  return (
    <div className="max-w-7xl">
      <PageHeader
        title={t("Follow-up alerts")}
        desc={
          <>
            {t("Players to contact now: close to a bonus, bonus ready or expiring, recalled, or due a second follow-up.")}{" "}
            <Info>
              {t("Alerts are worked out from the deposits staff enter, using each promotion's conditions (Promotions → Conditions) and Settings → Alerts. Logging a contact closes the player's alerts, so nobody is told twice. Alerts close by themselves when the period ends or the bonus expires.")}
            </Info>
          </>
        }
      />
      {!getsAlerts(user, settings) && !full && (
        <div className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">{t("Your role doesn't receive alerts (Settings → Alerts).")}</div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        {KINDS.map((k) => (
          <Link key={k} href={href({ kind: kind === k ? "" : k, tab: "open" })} className={`card p-3.5 hover:border-[var(--line-strong)] ${kind === k ? "ring-2 ring-brand" : ""}`}>
            <div className="text-xs text-ink-2">{t(KIND_LABEL[k])}</div>
            <div className="mt-1 text-lg font-semibold">{count(openCount(k))}</div>
          </Link>
        ))}
      </div>

      <Tabs
        items={[
          { href: href({ tab: "open" }), label: t("Open"), active: tab === "open", count: openCount() },
          { href: href({ tab: "done" }), label: t("Handled (last 14 days)"), active: tab === "done" },
        ]}
      />
      <form action="/alerts" className="mb-4 flex flex-wrap gap-2">
        {Object.entries(params)
          .filter(([k]) => k !== "kind" && k !== "who")
          .map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
        <AutoSelect name="kind" defaultValue={kind ?? ""} className="input h-8 w-auto">
          <option value="">{t("All alert types")}</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(KIND_LABEL[k])}
            </option>
          ))}
        </AutoSelect>
        {full && (
          <AutoSelect name="who" defaultValue={who} className="input h-8 w-auto">
            <option value="mine">{t("My alerts")}</option>
            <option value="all">{t("Everyone's alerts")}</option>
          </AutoSelect>
        )}
      </form>

      <Card flush>
        {rows.length === 0 ? (
          <Empty title={tab === "open" ? t("Nothing to follow up right now") : t("Nothing handled in the last 14 days")}>
            {tab === "open" ? t("New alerts pop up here as soon as deposits are entered.") : null}
          </Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Type")}</th>
                  <th>{t("Player")}</th>
                  {multi && <th>{t("Brand")}</th>}
                  <th>{t("What to tell the player")}</th>
                  <th>{t("For")}</th>
                  <th>{tab === "open" ? t("Raised") : t("Handled")}</th>
                  {tab === "open" && act && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const k = a.kind as AlertKindName;
                  const text = alertText(k, a.data, t, scope.brandCurrency(a.brandId));
                  const forWho = a.staffId ? (a.staffId === user.id ? t("You") : (staffName.get(a.staffId) ?? a.player.assignedTo?.name ?? t("Another CS"))) : t("Everyone on the brand");
                  const bonusAlert = (k === "ELIGIBLE" || k === "EXPIRING") && a.awardId;
                  return (
                    <tr key={a.id} className={focus === a.id ? "bg-brand-soft" : ""}>
                      <td>
                        <Chip tone={KIND_TONE[k]}>{t(KIND_LABEL[k])}</Chip>
                      </td>
                      <td>
                        <Link className="link font-medium" href={`/players/${a.playerId}`}>
                          {a.player.username}
                        </Link>
                        {a.player.name && <div className="text-xs text-muted">{a.player.name}</div>}
                      </td>
                      {multi && <td className="text-ink-2">{scope.brandName(a.brandId)}</td>}
                      <td>
                        <div className="font-medium">{text.title}</div>
                        <div className="text-xs text-ink-2">{text.detail}</div>
                      </td>
                      <td className="text-ink-2">{forWho}</td>
                      <td className="whitespace-nowrap text-ink-2">
                        {tab === "open" ? (
                          when(a.raisedAt)
                        ) : (
                          <>
                            {t(OUTCOME[a.outcome ?? ""] ?? a.outcome ?? "")}
                            <div className="text-xs text-muted">
                              {a.doneBy?.name ? a.doneBy.name + " · " : ""}
                              {when(a.doneAt)}
                            </div>
                          </>
                        )}
                      </td>
                      {tab === "open" && act && (
                        <td className="r space-x-1 whitespace-nowrap">
                          <Dialog label={t("Log contact")} title={t("Log contact: {name}", { name: a.player.username })} className="btn btn-sm btn-primary">
                            <div className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">
                              <div className="font-medium">{text.title}</div>
                              <div className="text-ink-2">{text.detail}</div>
                            </div>
                            <ContactForm
                              playerId={a.playerId}
                              channels={settings.csChannels}
                              templates={settings.csTemplates}
                              promos={promos.filter((p) => p.brandId === a.brandId)}
                              promotionId={a.promotionId}
                            />
                          </Dialog>
                          {bonusAlert && (
                            <ActionButton action={claimAlert} fields={{ id: a.id }} question={t("Record that {name} received this bonus?", { name: a.player.username })}>
                              {t("Claimed")}
                            </ActionButton>
                          )}
                          {k === "BOX" && (
                            <ActionButton action={releaseAlert} fields={{ id: a.id }} question={t("Record that {name} got {amount} back from the Lucky Box? Add it on the platform first.", { name: a.player.username, amount: money(Number((a.data as { bonus?: number }).bonus ?? 0), scope.brandCurrency(a.brandId)) })}>
                              {t("Released")}
                            </ActionButton>
                          )}
                          {!a.staffId && (
                            <ActionButton action={assignAlert} fields={{ id: a.id, staffId: user.id }}>
                              {t("Take")}
                            </ActionButton>
                          )}
                          <ActionButton action={dismissAlert} fields={{ id: a.id }} className="btn btn-sm btn-ghost">
                            {t("Dismiss")}
                          </ActionButton>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pager page={page} pages={Math.ceil(total / PER_PAGE)} href={(p) => href({ page: String(p) })} />
      </Card>
    </div>
  );
}
