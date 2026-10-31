import Link from "next/link";
import { BrandFilter } from "@/components/brand-filter";
import { AutoSelect } from "@/components/client";
import { TierChip } from "@/components/tier";
import { Card, Empty, Info, PageHeader, Pager, TableWrap } from "@/components/ui";
import { requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ago, count, d10, money0 } from "@/lib/format";
import { queryPlayers, tierName, tierOptions } from "@/lib/player-query";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { tk } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";

const PER_PAGE = 50;
const SORTS = [
  ["value", tk("Highest value first")],
  ["deposit", tk("Most deposits")],
  ["recent", tk("Deposited most recently")],
  ["idle", tk("Longest without a deposit")],
  ["net", tk("Highest net (deposit − withdrawal)")],
  ["newest", tk("Newest players")],
] as const;

export default async function PlayersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("players");
  const sp = await searchParams;
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const page = Math.max(1, Number(sp.page) || 1);
  const sort = (SORTS.find(([k]) => k === sp.sort)?.[0] ?? "value") as (typeof SORTS)[number][0];
  const tierRank = sp.tier != null && sp.tier !== "" ? Number(sp.tier) : undefined;
  const assigned = sp.cs === "me" ? "me" : sp.cs === "none" ? "none" : sp.cs ? Number(sp.cs) : undefined;

  const [{ rows, total }, staff] = await Promise.all([
    queryPlayers(settings.tierScoring, {
      brandIds: scope.brandIds,
      q: sp.q?.trim() || undefined,
      tierRank,
      assigned,
      meId: user.id,
      sort,
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    }),
    prisma.user.findMany({ where: { active: true, contacts: { some: {} } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const params = Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "page")) as Record<string, string>;
  const qs = (p: number) => `/players?${new URLSearchParams({ ...params, page: String(p) })}`;
  const multi = !scope.current;

  return (
    <div className="max-w-7xl">
      <PageHeader
        title={t("Players")}
        desc={
          <>
            {t("Lifetime figures for every player. Tiers follow the rules in Settings.")}{" "}
            <Info>
              {t("Each player gets a score out of 100 from their total deposits, number of deposits and average deposit. The score decides the tier. Change the rules under Settings → Player tiers.")}
            </Info>
          </>
        }
        actions={
          <a className="btn" href={`/api/export/players?${new URLSearchParams(params)}`}>
            ⬇ {t("Export Excel")}
          </a>
        }
      />
      <form action="/players" className="mb-4 flex flex-wrap gap-2">
        <BrandFilter />
        <input name="q" defaultValue={sp.q} className="input h-9 w-64" placeholder={t("Search username, name or phone")} />
        <AutoSelect name="tier" defaultValue={sp.tier ?? ""} className="input w-auto">
          <option value="">{t("All tiers")}</option>
          {tierOptions(settings.tierScoring).map((x) => (
            <option key={x.rank} value={x.rank}>
              {t(x.name)}
            </option>
          ))}
        </AutoSelect>
        <AutoSelect name="cs" defaultValue={sp.cs ?? ""} className="input w-auto">
          <option value="">{t("Any CS")}</option>
          <option value="me">{t("Assigned to me")}</option>
          <option value="none">{t("Not assigned")}</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </AutoSelect>
        <AutoSelect name="sort" defaultValue={sort} className="input w-auto">
          {SORTS.map(([k, label]) => (
            <option key={k} value={k}>
              {t(label)}
            </option>
          ))}
        </AutoSelect>
        <button className="btn">{t("Search")}</button>
        {Object.keys(params).length > 0 && (
          <Link href="/players" className="btn btn-ghost">
            {t("Clear")}
          </Link>
        )}
      </form>

      <Card flush title={t("{n} players", { n: count(total) })} note={scope.current ? scope.current.name : t("All brands")}>
        {rows.length === 0 ? (
          <Empty title={sp.q ? t("No player matches “{q}”", { q: sp.q }) : t("No players yet")}>{t("Players appear here as soon as deposits, withdrawals or a player list are entered or imported.")}</Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Player")}</th>
                  {multi && <th>{t("Brand")}</th>}
                  <th>{t("Tier")}</th>
                  <th className="r">{t("Deposits")}</th>
                  <th className="r">{t("Withdrawals")}</th>
                  <th className="r">{t("Net")}</th>
                  <th className="r">{t("Avg deposit")}</th>
                  <th>{t("Last deposit")}</th>
                  <th>{t("CS")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const tier = tierName(settings.tierScoring, p.score);
                  const cur = scope.brandCurrency(p.brandId);
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/players/${p.id}`} className="font-medium hover:underline">
                          {p.username}
                        </Link>
                        {(p.name || p.phone) && <div className="text-xs text-muted">{[p.name, p.phone].filter(Boolean).join(" · ")}</div>}
                      </td>
                      {multi && <td className="text-ink-2">{scope.brandName(p.brandId)}</td>}
                      <td>
                        <TierChip name={tier.name} rank={tier.rank} score={p.score} />
                      </td>
                      <td className="r">
                        {money0(p.depositTotal, cur)} <span className="text-xs text-muted">×{p.depositCount}</span>
                      </td>
                      <td className="r">
                        {money0(p.withdrawTotal, cur)} <span className="text-xs text-muted">×{p.withdrawCount}</span>
                      </td>
                      <td className={`r font-medium ${p.depositTotal - p.withdrawTotal < 0 ? "text-critical-ink" : ""}`}>{money0(p.depositTotal - p.withdrawTotal, cur)}</td>
                      <td className="r">{p.depositCount ? money0(p.depositTotal / p.depositCount, cur) : "–"}</td>
                      <td className="whitespace-nowrap">
                        {d10(p.lastDepositAt)}
                        {p.lastDepositAt && <div className="text-xs text-muted">{ago(p.lastDepositAt, t)}</div>}
                      </td>
                      <td className="text-ink-2">{p.assignedName ?? "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pager page={page} pages={Math.ceil(total / PER_PAGE)} href={qs} />
      </Card>
    </div>
  );
}
