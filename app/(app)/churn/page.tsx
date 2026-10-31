import Link from "next/link";
import { ActionButton, AutoSelect, Dialog } from "@/components/client";
import { BrandFilter } from "@/components/brand-filter";
import { ContactForm } from "@/components/contact-form";
import { TierChip } from "@/components/tier";
import { Card, Chip, Empty, Info, PageHeader, Pager, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ago, count, d10, money0 } from "@/lib/format";
import { queryPlayers, tierName, tierOptions, type PlayerFilter } from "@/lib/player-query";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { getT } from "@/lib/i18n-server";
import { assignPlayer } from "../cs/actions";

const PER_PAGE = 50;

function cutoff(days: number) {
  return new Date(Date.now() - days * 86400_000);
}

export default async function ChurnPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("churn");
  const sp = await searchParams;
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const days = settings.churnDays.length ? settings.churnDays : [7, 15, 30];
  const page = Math.max(1, Number(sp.page) || 1);
  const canLog = can(user, "churn", 2) || can(user, "cs", 2);
  const full = can(user, "churn", 3);

  // Tabs: one per threshold band, plus everything past the first threshold.
  const bands = days.map((d, i) => ({
    key: String(i),
    label: i < days.length - 1 ? t("{a}–{b} days", { a: d, b: days[i + 1] - 1 }) : t("{a}+ days", { a: d }),
    idleBefore: cutoff(d),
    idleAfter: i < days.length - 1 ? cutoff(days[i + 1]) : undefined,
  }));
  const tabs = [{ key: "all", label: t("All ({a}+ days)", { a: days[0] }), idleBefore: cutoff(days[0]), idleAfter: undefined as Date | undefined }, ...bands];
  const tab = tabs.find((t) => t.key === sp.band) ?? tabs[0];

  const base: Omit<PlayerFilter, "limit" | "offset"> = {
    brandIds: scope.brandIds,
    hasDeposit: true,
    tierRank: sp.tier ? Number(sp.tier) : undefined,
    assigned: sp.cs === "me" ? "me" : sp.cs === "none" ? "none" : undefined,
    meId: user.id,
    contacted: sp.status === "contacted" ? true : sp.status === "open" ? false : undefined,
    refollowBefore: sp.status === "again" && settings.refollowDays > 0 ? cutoff(settings.refollowDays) : undefined,
  };
  const [list, counts, promos] = await Promise.all([
    queryPlayers(settings.tierScoring, { ...base, idleBefore: tab.idleBefore, idleAfter: tab.idleAfter, sort: "value", limit: PER_PAGE, offset: (page - 1) * PER_PAGE }),
    Promise.all(tabs.map((t) => queryPlayers(settings.tierScoring, { ...base, idleBefore: t.idleBefore, idleAfter: t.idleAfter, limit: 0, offset: 0 }).then((r) => r.total))),
    prisma.promotion.findMany({ where: { brandId: { in: scope.brandIds }, active: true }, select: { id: true, name: true, brandId: true }, orderBy: { name: "asc" } }),
  ]);
  const ids = list.rows.map((r) => r.id);
  const contacts = ids.length
    ? await prisma.contactLog.findMany({ where: { playerId: { in: ids } }, include: { staff: true }, orderBy: { contactedAt: "desc" } })
    : [];
  const lastContact = new Map<number, (typeof contacts)[number]>();
  for (const c of contacts) if (!lastContact.has(c.playerId)) lastContact.set(c.playerId, c);
  const timesContacted = (playerId: number, since: Date | null) => contacts.filter((c) => c.playerId === playerId && (!since || c.contactedAt > since)).length;
  const recallSince = cutoff(settings.recallDays);
  const nowMs = cutoff(0).getTime();

  const params = Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "page")) as Record<string, string>;
  const href = (q: Record<string, string>) => `/churn?${new URLSearchParams({ ...params, ...q })}`;
  const multi = !scope.current;

  return (
    <div className="max-w-7xl">
      <PageHeader
        title={t("Churn follow-up")}
        desc={
          <>
            {t("Players who used to deposit but have stopped, most valuable first.")}{" "}
            <Info>
              {t("A player is listed once their last deposit is older than the thresholds in Settings → Churn & CS ({days} days). When they deposit again they drop off the list automatically.", { days: days.join(", ") })}
            </Info>
          </>
        }
      />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t, i) => (
          <Link
            key={t.key}
            href={href({ band: t.key, page: "1" })}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              t.key === tab.key ? "border-brand font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {t.label}
            <span className={`rounded px-1.5 text-xs ${i === tabs.length - 1 && counts[i] > 0 ? "bg-critical-soft text-critical-ink" : "bg-surface-2 text-ink-2"}`}>
              {count(counts[i])}
            </span>
          </Link>
        ))}
        {can(user, "settings", 3) && (
          <Link href="/admin/settings?tab=followup" className="ml-auto self-center px-2 text-xs text-ink-2 hover:text-ink hover:underline">
            {t("Change days")}
          </Link>
        )}
      </div>
      <form action="/churn" className="mb-4 flex flex-wrap gap-2">
        <BrandFilter />
        <input type="hidden" name="band" value={tab.key} />
        <AutoSelect name="tier" defaultValue={sp.tier ?? ""} className="input w-auto">
          <option value="">{t("All tiers")}</option>
          {tierOptions(settings.tierScoring).map((x) => (
            <option key={x.rank} value={x.rank}>
              {t(x.name)}
            </option>
          ))}
        </AutoSelect>
        <AutoSelect name="status" defaultValue={sp.status ?? ""} className="input w-auto">
          <option value="">{t("Any follow-up status")}</option>
          <option value="open">{t("Not contacted yet")}</option>
          <option value="contacted">{t("Already contacted")}</option>
          {settings.refollowDays > 0 && <option value="again">{t("Due a follow-up again ({n}+ days)", { n: settings.refollowDays })}</option>}
        </AutoSelect>
        <AutoSelect name="cs" defaultValue={sp.cs ?? ""} className="input w-auto">
          <option value="">{t("Any CS")}</option>
          <option value="me">{t("My players")}</option>
          <option value="none">{t("Not assigned")}</option>
        </AutoSelect>
      </form>

      <Card flush>
        {list.rows.length === 0 ? (
          <Empty title={t("Nobody to follow up here")}>{t("Every player in this group has deposited recently, or no one matches the filters.")}</Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Player")}</th>
                  {multi && <th>{t("Brand")}</th>}
                  <th>{t("Tier")}</th>
                  <th className="r">{t("Lifetime deposits")}</th>
                  <th>{t("Last deposit")}</th>
                  <th>{t("CS")}</th>
                  <th>{t("Last follow-up")}</th>
                  {canLog && <th />}
                </tr>
              </thead>
              <tbody>
                {list.rows.map((p) => {
                  const tier = tierName(settings.tierScoring, p.score);
                  const c = lastContact.get(p.id);
                  const afterLastDeposit = c && p.lastDepositAt && c.contactedAt > p.lastDepositAt;
                  const other = c && c.staffId !== user.id && c.contactedAt > recallSince ? { name: c.staff.name, when: ago(c.contactedAt, t) } : null;
                  const idle = Math.floor((nowMs - (p.lastDepositAt?.getTime() ?? 0)) / 86400_000);
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/players/${p.id}`} className="font-medium hover:underline">
                          {p.username}
                        </Link>
                        {p.phone && <div className="text-xs text-muted">{p.phone}</div>}
                      </td>
                      {multi && <td className="text-ink-2">{scope.brandName(p.brandId)}</td>}
                      <td>
                        <TierChip name={tier.name} rank={tier.rank} />
                      </td>
                      <td className="r">
                        <div>
                          {money0(p.depositTotal, scope.brandCurrency(p.brandId))} <span className="text-xs text-muted">×{p.depositCount}</span>
                        </div>
                        {p.depositCount > 0 && <div className="text-xs text-muted">{t("avg {amount}", { amount: money0(p.depositTotal / p.depositCount, scope.brandCurrency(p.brandId)) })}</div>}
                      </td>
                      <td className="whitespace-nowrap">
                        <span className={idle >= days[days.length - 1] ? "font-medium text-critical-ink" : ""}>{t("{n} days ago", { n: idle })}</span>
                        <div className="text-xs text-muted">{d10(p.lastDepositAt)}</div>
                      </td>
                      <td className="text-ink-2">
                        {p.assignedName ??
                          (canLog ? (
                            <ActionButton action={assignPlayer} fields={{ playerId: p.id, staffId: "me" }} className="btn btn-sm">
                              {t("Take")}
                            </ActionButton>
                          ) : (
                            "–"
                          ))}
                      </td>
                      <td className="max-w-72">
                        {afterLastDeposit && c ? (
                          <>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Chip tone={c.replied ? "good" : "warning"}>{c.replied ? t("Replied") : t("No reply")}</Chip>
                              <span className="text-xs text-ink-2">
                                {c.staff.name} · {t(c.channel)} · {ago(c.contactedAt, t)}
                              </span>
                              <span className="text-xs text-muted" title={t("Contacts since the last deposit / in total")}>
                                {t("{a} times", { a: timesContacted(p.id, p.lastDepositAt) })}
                                {timesContacted(p.id, null) > timesContacted(p.id, p.lastDepositAt) ? " / " + timesContacted(p.id, null) : ""}
                              </span>
                              {settings.refollowDays > 0 && c.contactedAt.getTime() < nowMs - settings.refollowDays * 86400_000 && <Chip tone="warning">{t("Follow up again")}</Chip>}
                            </div>
                            {c.result && <div className="mt-0.5 truncate text-xs text-ink-2">{c.result}</div>}
                          </>
                        ) : (
                          <Chip tone="critical">{t("Not contacted")}</Chip>
                        )}
                      </td>
                      {canLog && (
                        <td className="r">
                          <Dialog label={t("Log contact")} title={t("Log contact: {name}", { name: p.username })} className="btn btn-sm">
                            <ContactForm playerId={p.id} channels={settings.csChannels} templates={settings.csTemplates} promos={promos.filter((x) => x.brandId === p.brandId)} who={other} />
                          </Dialog>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pager page={page} pages={Math.ceil(list.total / PER_PAGE)} href={(n) => href({ page: String(n) })} />
      </Card>
      {full && <p className="mt-3 text-xs text-muted">{t("To hand a player to someone else, open the player and use “Assign CS”.")}</p>}
    </div>
  );
}
