import Link from "next/link";
import { AutoSelect } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Chip, Empty, PageHeader, Pager, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { txnModule } from "@/lib/perms";
import { prisma } from "@/lib/db";
import { editRights } from "@/lib/edit-rights";
import { count, dt, money, n, num2 } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { getScope } from "@/lib/scope";
import { txnFilter } from "@/lib/txn-filter";
import { EditCell, payTo, TxnFields } from "../entry/edit-cell";

const PER_PAGE = 50;
const FILTERS = ["q", "type", "channel", "by", "source", "player"];

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("transactions");
  const sp = await searchParams;
  const [scope, t, rights] = await Promise.all([getScope(user), getT(), editRights(user, "entry")]);
  const page = Math.max(1, Number(sp.page) || 1);
  const { range, where, playerId } = txnFilter(sp, scope.brandIds);
  const canEdit = can(user, "entry", 2);

  const [rows, sums, byWho, channels, staff, player] = await Promise.all([
    prisma.txn.findMany({
      where,
      include: { player: { select: { username: true } }, channel: { select: { name: true } }, createdBy: { select: { name: true } } },
      orderBy: [{ txnAt: "desc" }, { id: "desc" }],
      take: PER_PAGE,
      skip: (page - 1) * PER_PAGE,
    }),
    prisma.txn.groupBy({ by: ["brandId", "type"], where, _sum: { amount: true }, _count: { _all: true } }),
    prisma.txn.groupBy({ by: ["createdById"], where, _count: { _all: true } }),
    prisma.payChannel.findMany({ orderBy: [{ active: "desc" }, { type: "asc" }, { name: "asc" }], select: { id: true, name: true, active: true } }),
    prisma.user.findMany({ where: { txnsEntered: { some: { brandId: { in: scope.brandIds } } } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    playerId ? prisma.player.findFirst({ where: { id: playerId, brandId: { in: scope.brandIds } }, select: { username: true } }) : null,
  ]);
  const importIds = [...new Set(rows.flatMap((r) => (r.importId ? [r.importId] : [])))];
  const files = new Map(
    importIds.length ? (await prisma.importBatch.findMany({ where: { id: { in: importIds } }, select: { id: true, filename: true } })).map((b) => [b.id, b.filename]) : [],
  );

  // Totals of everything that matches, not just this page, in the page currency.
  const tot = { dep: 0, wd: 0, depN: 0, wdN: 0 };
  for (const s of sums) {
    const v = n(s._sum.amount) * scope.rate(s.brandId);
    if (s.type === "DEPOSIT") {
      tot.dep += v;
      tot.depN += s._count._all;
    } else {
      tot.wd += v;
      tot.wdN += s._count._all;
    }
  }
  const total = tot.depN + tot.wdN;
  const names = new Map(staff.map((s) => [s.id, s.name]));
  const who = byWho
    .map((g) => ({ id: g.createdById, name: g.createdById ? (names.get(g.createdById) ?? `#${g.createdById}`) : "–", n: g._count._all }))
    .sort((a, b) => b.n - a.n);

  const params = Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "page")) as Record<string, string>;
  const keep = (drop: string[]) => `/transactions?${new URLSearchParams(Object.entries(params).filter(([k]) => !drop.includes(k)))}`;
  const filtered = FILTERS.some((k) => params[k]);
  const chOpts = channels.map((c) => ({ value: String(c.id), label: c.active ? c.name : `${c.name} (${t("Inactive")})` }));
  const multi = !scope.current;

  return (
    <div className="max-w-7xl">
      <PageHeader
        title={t("Transactions")}
        desc={t("Every deposit and withdrawal, with who entered it and when.")}
        actions={
          <a className="btn" href={`/api/export/transactions?${new URLSearchParams(params)}`}>
            ⬇ {t("Export Excel")}
          </a>
        }
      />
      <div className="mb-4 space-y-2">
        <RangeBar path="/transactions" range={range} params={sp} />
        <form action="/transactions" className="flex flex-wrap items-center gap-2">
          {range.preset ? (
            <input type="hidden" name="preset" value={range.preset} />
          ) : (
            <>
              <input type="hidden" name="from" value={range.from} />
              <input type="hidden" name="to" value={range.to} />
            </>
          )}
          {player && (
            <>
              <input type="hidden" name="player" value={playerId} />
              <Chip tone="brand">
                {t("Player")}: {player.username}{" "}
                <Link href={keep(["player"])} className="ml-0.5 hover:text-ink" aria-label={t("Remove")}>
                  ✕
                </Link>
              </Chip>
            </>
          )}
          <input name="q" defaultValue={sp.q} className="input h-8 w-56" placeholder={t("Search player or reference no.")} />
          <AutoSelect name="type" defaultValue={sp.type ?? ""} className="input h-8 w-auto">
            <option value="">{t("Deposits & withdrawals")}</option>
            <option value="DEPOSIT">{t("Deposits only")}</option>
            <option value="WITHDRAW">{t("Withdrawals only")}</option>
          </AutoSelect>
          <AutoSelect name="channel" defaultValue={sp.channel ?? ""} className="input h-8 w-auto">
            <option value="">{t("All PG / banks")}</option>
            {chOpts.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
            <option value="none">{t("No PG / bank")}</option>
          </AutoSelect>
          <AutoSelect name="by" defaultValue={sp.by ?? ""} className="input h-8 w-auto">
            <option value="">{t("Entered by anyone")}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </AutoSelect>
          <AutoSelect name="source" defaultValue={sp.source ?? ""} className="input h-8 w-auto">
            <option value="">{t("Typed in or imported")}</option>
            <option value="typed">{t("Typed in")}</option>
            <option value="excel">{t("Excel import")}</option>
          </AutoSelect>
          <button className="btn btn-sm h-8">{t("Search")}</button>
          {filtered && (
            <Link href={keep(FILTERS)} className="btn btn-ghost btn-sm h-8">
              {t("Clear")}
            </Link>
          )}
        </form>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={t("Deposits")} value={money(tot.dep, scope.currency)} sub={t("{n} transactions", { n: count(tot.depN) })} />
        <Tile label={t("Withdrawals")} value={money(tot.wd, scope.currency)} sub={t("{n} transactions", { n: count(tot.wdN) })} />
        <Tile label={t("Deposits − withdrawals")} value={money(tot.dep - tot.wd, scope.currency)} sub={scope.current ? scope.current.name : t("All brands")} />
        <div className="card p-3.5">
          <div className="text-xs text-ink-2">{t("Entered by")}</div>
          {who.length === 0 ? (
            <div className="mt-1 text-lg font-semibold">–</div>
          ) : (
            <ul className="mt-1 space-y-0.5 text-sm">
              {who.slice(0, 3).map((w) => (
                <li key={w.id ?? 0} className="flex justify-between gap-2">
                  {w.id ? (
                    <Link className="truncate hover:underline" href={`/transactions?${new URLSearchParams({ ...params, by: String(w.id) })}`}>
                      {w.name}
                    </Link>
                  ) : (
                    <span className="truncate">{w.name}</span>
                  )}
                  <span className="text-ink-2 tabular-nums">{count(w.n)}</span>
                </li>
              ))}
              {who.length > 3 && <li className="text-xs text-muted">{t("+{n} more", { n: who.length - 3 })}</li>}
            </ul>
          )}
        </div>
      </div>

      <Card flush title={t("{n} transactions", { n: count(total) })} note={rights.note || undefined}>
        {rows.length === 0 ? (
          <Empty title={filtered ? t("Nothing matches these filters") : t("No transactions in this period")} />
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Time")}</th>
                  {multi && <th>{t("Brand")}</th>}
                  <th>{t("Player")}</th>
                  <th>{t("Type")}</th>
                  <th className="r">{t("Amount")}</th>
                  <th>{t("PG / bank")}</th>
                  <th>{t("Withdrawal bank / account")}</th>
                  <th>{t("Note")}</th>
                  <th>{t("Ref")}</th>
                  <th>{t("Entered by")}</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((tx) => (
                  <tr key={tx.id} className={tx.type === "DEPOSIT" ? "row-dep" : "row-wd"}>
                    <td className="whitespace-nowrap text-ink-2">{dt(tx.txnAt)}</td>
                    {multi && <td className="text-ink-2">{scope.brandName(tx.brandId)}</td>}
                    <td className="font-medium">
                      <Link className="hover:underline" href={`/players/${tx.playerId}`}>
                        {tx.player.username}
                      </Link>
                    </td>
                    <td>{tx.type === "DEPOSIT" ? <Chip tone="good">{t("Deposit")}</Chip> : <Chip tone="warning">{t("Withdrawal")}</Chip>}</td>
                    <td className="r font-medium">{num2(tx.amount)}</td>
                    <td className="text-ink-2">{tx.channel?.name ?? "–"}</td>
                    <td className="whitespace-nowrap text-ink-2">{payTo(tx)}</td>
                    <td className="max-w-48 truncate text-ink-2" title={tx.note ?? undefined}>
                      {tx.note ?? ""}
                    </td>
                    <td className="text-ink-2">{tx.ref ?? "–"}</td>
                    <td className="whitespace-nowrap">
                      <div>{tx.createdBy?.name ?? "–"}</div>
                      <div className="text-xs text-muted" title={tx.importId ? files.get(tx.importId) : undefined}>
                        {dt(tx.createdAt)}
                        {tx.importId ? ` · ${t("Excel import")}` : ""}
                      </div>
                    </td>
                    {canEdit && (
                      <EditCell kind="txn" id={tx.id} label={t("transaction")} brand={scope.brandName(tx.brandId)} username={tx.player.username} allowed={rights.may(tx.createdById, tx.createdAt) && can(user, txnModule(tx.type), 2)} t={t}>
                        <TxnFields tx={tx} channels={chOpts} t={t} />
                      </EditCell>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pager page={page} pages={Math.ceil(total / PER_PAGE)} href={(p) => `/transactions?${new URLSearchParams({ ...params, page: String(p) })}`} />
      </Card>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card p-3.5">
      <div className="text-xs text-ink-2">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted">{sub}</div>
    </div>
  );
}
