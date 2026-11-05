import Link from "next/link";
import { BrandFilter } from "@/components/brand-filter";
import { AutoSelect } from "@/components/client";
import { PLAYER_STATUSES, StatusChip, TierChip } from "@/components/tier";
import { Card, Empty, Info, PageHeader, Pager, TableWrap } from "@/components/ui";
import { can, requirePage, seesWithdrawals } from "@/lib/auth";
import { ago, count, d10, num0, sym } from "@/lib/format";
import { type PlayerSort, playerSort, queryPlayers, statusParam, tierName, tierOptions } from "@/lib/player-query";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { tk } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { BrandTag } from "@/components/brand-tag";

const PER_PAGE = 50;
const SORTS: [PlayerSort, string][] = [
  ["value", tk("Highest value first")],
  ["deposit", tk("Most deposits")],
  ["count", tk("Most deposit times")],
  ["avg", tk("Highest average deposit")],
  ["withdraw", tk("Most withdrawn")],
  ["wcount", tk("Most withdrawal times")],
  ["recent", tk("Deposited most recently")],
  ["idle", tk("Longest without a deposit")],
  ["net", tk("Highest net (deposit − withdrawal)")],
  ["newest", tk("Newest players")],
];
/** Sorts only staff who see withdrawals get. */
const WD_SORTS: PlayerSort[] = ["withdraw", "wcount", "net"];

export default async function PlayersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("players");
  const sp = await searchParams;
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const page = Math.max(1, Number(sp.page) || 1);
  const wd = seesWithdrawals(user);
  const sorts = SORTS.filter(([k]) => wd || !WD_SORTS.includes(k));
  const requested = playerSort(sp.sort);
  const sort: PlayerSort = requested && (wd || !WD_SORTS.includes(requested)) ? requested : "value";
  const asc = sp.dir === "asc";
  const tierRank = sp.tier != null && sp.tier !== "" ? Number(sp.tier) : undefined;

  const { rows, total } = await queryPlayers(settings.tierScoring, {
    brandIds: scope.brandIds,
    q: sp.q?.trim() || undefined,
    tierRank,
    status: statusParam(sp.status),
    sort,
    asc,
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
  });
  // The CS filter is gone; a bookmarked ?cs= is dropped from links rather than carried along.
  const params = Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "page" && k !== "cs")) as Record<string, string>;
  const qs = (p: number) => `/players?${new URLSearchParams({ ...params, page: String(p) })}`;
  const multi = !scope.current;
  // Amounts show without a currency sign; when the listed brands use different currencies, the brand cell says which.
  const mixedCurrency = new Set(rows.map((p) => scope.brandCurrency(p.brandId))).size > 1;

  /** A header that sorts by its column: highest first, a second click lowest first. "Last deposit" flips between recent and idle. */
  const sortHead = (label: string, key: PlayerSort, flip?: PlayerSort) => {
    const active = sort === key || (flip != null && sort === flip);
    const next: Record<string, string> = flip ? { sort: sort === key ? flip : key } : { sort: key, ...(sort === key && !asc ? { dir: "asc" } : {}) };
    const rest = Object.fromEntries(Object.entries(params).filter(([k]) => k !== "sort" && k !== "dir"));
    const arrow = !active ? "↕" : flip ? (sort === key ? "↓" : "↑") : asc ? "↑" : "↓";
    return (
      <Link href={`/players?${new URLSearchParams({ ...rest, ...next })}`} className="inline-flex items-center gap-1 hover:underline">
        {t(label)}
        <span className={active ? "" : "opacity-50"}>{arrow}</span>
      </Link>
    );
  };

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
          <>
            <a className="btn" href={`/api/export/players?${new URLSearchParams(params)}`}>
              ⬇ {t("Export Excel")}
            </a>
            {can(user, "entry", 2) && (
              <Link href="/players/add" className="btn btn-primary">
                + {t("Add players")}
              </Link>
            )}
          </>
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
        <AutoSelect name="status" defaultValue={sp.status ?? ""} className="input w-auto">
          <option value="">{t("Any status")}</option>
          {PLAYER_STATUSES.map(([v, label]) => (
            <option key={v} value={v}>
              {t(label)}
            </option>
          ))}
        </AutoSelect>
        <AutoSelect name="sort" defaultValue={sort} className="input w-auto">
          {sorts.map(([k, label]) => (
            <option key={k} value={k}>
              {t(label)}
            </option>
          ))}
        </AutoSelect>
        <button className="btn btn-primary">{t("Search")}</button>
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
            <table className="tbl tbl-players">
              <thead>
                <tr>
                  {multi && <th>{t("Brand")}</th>}
                  <th>{t("Player")}</th>
                  <th>{t("Tier")}</th>
                  <th className="r sort">{sortHead("Total deposits", "deposit")}</th>
                  <th className="r sort">{sortHead("Deposit times", "count")}</th>
                  <th className="r sort">{sortHead("Avg deposit", "avg")}</th>
                  {wd && <th className="r sort">{sortHead("Total withdrawals", "withdraw")}</th>}
                  {wd && <th className="r sort">{sortHead("Withdrawal times", "wcount")}</th>}
                  {wd && <th className="r sort">{sortHead("Net", "net")}</th>}
                  <th className="sort">{sortHead("Last deposit", "recent", "idle")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const tier = tierName(settings.tierScoring, p.score);
                  const net = p.depositTotal - p.withdrawTotal;
                  return (
                    <tr key={p.id}>
                      {multi && (
                        <td className="font-semibold">
                          <BrandTag id={p.brandId} />
                          {mixedCurrency && <div className="text-xs font-normal text-muted">{sym(scope.brandCurrency(p.brandId))}</div>}
                        </td>
                      )}
                      <td className="whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Link href={`/players/${p.id}`} className="font-semibold hover:underline">
                            {p.username}
                          </Link>
                          <StatusChip status={p.status} />
                        </div>
                        {(p.name || p.phone) && (
                          <div className="max-w-52 truncate text-xs text-muted" title={[p.name, p.phone].filter(Boolean).join(" · ")}>
                            {[p.name, p.phone].filter(Boolean).join(" · ")}
                          </div>
                        )}
                        {p.note && (
                          <div className="max-w-64 truncate text-xs text-warning-ink" title={p.note}>
                            {p.note}
                          </div>
                        )}
                      </td>
                      <td>
                        <TierChip name={tier.name} rank={tier.rank} score={p.score} />
                      </td>
                      <td className="r big dep">{num0(p.depositTotal)}</td>
                      <td className="r mid">{count(p.depositCount)}</td>
                      <td className="r mid good">{p.depositCount ? num0(p.depositTotal / p.depositCount) : "–"}</td>
                      {wd && <td className="r big wd">{num0(p.withdrawTotal)}</td>}
                      {wd && <td className="r mid">{count(p.withdrawCount)}</td>}
                      {wd && <td className={`r mid ${net < 0 ? "wd" : ""}`}>{num0(net)}</td>}
                      <td className="whitespace-nowrap text-xs">
                        {d10(p.lastDepositAt)}
                        {p.lastDepositAt && <div className="text-muted">{ago(p.lastDepositAt, t)}</div>}
                      </td>
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
