import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, ActionForm, Dialog, Submit } from "@/components/client";
import { ContactForm } from "@/components/contact-form";
import { TierChip } from "@/components/tier";
import { Card, Chip, Empty, Field, Info, TableWrap } from "@/components/ui";
import { can, canSeeBrand, requirePage } from "@/lib/auth";
import { dayOf, todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { editRights } from "@/lib/edit-rights";
import { ago, d10, dt, money, money0, n } from "@/lib/format";
import { getSettings, scorePlayer } from "@/lib/settings";
import { assignPlayer, deleteContact } from "../../cs/actions";
import { updatePlayer } from "../actions";
import { getT } from "@/lib/i18n-server";
import { progressText, readRule, tierMet } from "@/lib/promo-rule";
import { boxPromos, boxStates } from "@/lib/lucky-box";

function daysAgo(days: number) {
  return Date.now() - days * 86400_000;
}

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePage("players");
  const id = Number((await params).id);
  const player = Number.isInteger(id) ? await prisma.player.findUnique({ where: { id }, include: { brand: true, assignedTo: true } }) : null;
  if (!player || !canSeeBrand(user, player.brandId)) notFound();

  const [settings, t, csRights] = await Promise.all([getSettings(), getT(), editRights(user, "cs")]);
  const cur = player.brand.currency;
  const dep = n(player.depositTotal);
  const wd = n(player.withdrawTotal);
  const tier = scorePlayer(settings.tierScoring, dep, player.depositCount);
  const s = settings.tierScoring;
  const canEdit = can(user, "players", 3);
  const canLog = can(user, "cs", 2) || can(user, "churn", 2);

  const [txns, claims, contacts, twins, months, promos, staff, firstTxn] = await Promise.all([
    prisma.txn.findMany({ where: { playerId: id }, include: { channel: true, createdBy: { select: { name: true } } }, orderBy: { txnAt: "desc" }, take: 50 }),
    prisma.promoClaim.findMany({ where: { playerId: id }, include: { promotion: true }, orderBy: { claimedAt: "desc" }, take: 20 }),
    prisma.contactLog.findMany({ where: { playerId: id }, include: { staff: true, promotion: true }, orderBy: { contactedAt: "desc" }, take: 30 }),
    player.phoneKey
      ? prisma.player.findMany({ where: { phoneKey: player.phoneKey, id: { not: id } }, include: { brand: true } })
      : Promise.resolve([]),
    prisma.$queryRaw<{ m: string; type: string; amt: unknown; cnt: bigint }[]>`
      SELECT DATE_FORMAT(DATE_ADD(txnAt, INTERVAL 8 HOUR), '%Y-%m') AS m, type, SUM(amount) AS amt, COUNT(*) AS cnt
      FROM \`Txn\` WHERE playerId = ${id} AND txnAt >= DATE_SUB(NOW(), INTERVAL 12 MONTH) GROUP BY m, type ORDER BY m`,
    prisma.promotion.findMany({ where: { brandId: player.brandId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    can(user, "churn", 3) || canEdit ? prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
    prisma.txn.findFirst({ where: { playerId: id }, orderBy: { txnAt: "asc" }, select: { txnAt: true } }),
  ]);
  // Only for brands connected to their platform: bets over the last 30 days.
  const bets = await prisma.playerDay.aggregate({ where: { playerId: id, day: { gte: new Date(Date.now() - 30 * 86400_000) } }, _sum: { bet: true } });
  const visibleTwins = twins.filter((t) => canSeeBrand(user, t.brandId));
  // Progress towards tracked promotions in their current periods, and bonuses not claimed yet.
  const [progress, openAwards] = await Promise.all([
    prisma.promoProgress.findMany({ where: { playerId: id, periodEnd: { gt: new Date() } }, include: { promotion: true }, orderBy: { periodKey: "desc" } }),
    prisma.promoAward.findMany({
      where: { playerId: id, claimedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      include: { promotion: { select: { name: true } } },
      orderBy: { eligibleAt: "desc" },
      take: 20,
    }),
  ]);
  const boxes = (await boxStates({ playerIds: [id], promos: await boxPromos([player.brandId], false) })).filter((b) => b.balance > 0.005 || b.stored > 0);
  const boxName = new Map((await prisma.promotion.findMany({ where: { id: { in: boxes.map((b) => b.promotionId) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const tracking = progress.flatMap((p) => {
    const rule = readRule(p.promotion.rule);
    if (!rule || !p.promotion.active) return [];
    const next = rule.tiers.findIndex((tr) => !tierMet(rule, tr, n(p.amount), p.count));
    return [{ p, rule, next }];
  });
  const since = daysAgo(settings.recallDays);
  const lastOther = contacts.find((c) => c.staffId !== user.id && c.contactedAt.getTime() > since);

  const byMonth = new Map<string, { dep: number; wd: number }>();
  for (const m of months) {
    const row = byMonth.get(m.m) ?? { dep: 0, wd: 0 };
    if (m.type === "DEPOSIT") row.dep += n(m.amt as number);
    else row.wd += n(m.amt as number);
    byMonth.set(m.m, row);
  }
  const monthMax = Math.max(1, ...[...byMonth.values()].map((v) => Math.max(v.dep, v.wd)));

  const crossTotal = visibleTwins.reduce(
    (a, t) => ({ dep: a.dep + n(t.depositTotal) * n(t.brand.fxRate), wd: a.wd + n(t.withdrawTotal) * n(t.brand.fxRate) }),
    { dep: dep * n(player.brand.fxRate), wd: wd * n(player.brand.fxRate) },
  );

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <Link href="/players" className="text-sm text-ink-2 hover:underline">
            ← {t("Players")}
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold">
            {player.username}
            <TierChip name={tier.tier} rank={tier.rank} score={tier.score} />
          </h1>
          <p className="mt-0.5 text-sm text-ink-2">
            {player.brand.name}
            {player.name && ` · ${player.name}`}
            {player.phone && ` · ${player.phone}`}
            {player.registeredAt && ` · ${t("Registered {d}", { d: d10(player.registeredAt) })}`}
            {player.referrer && ` · ${t("Referrer: {r}", { r: player.referrer })}`}
            {bets._sum.bet != null && ` · ${t("Bets (last 30 days): {a}", { a: money0(n(bets._sum.bet), cur) })}`}
            {player.note && <span className="block text-muted">{player.note}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-2">CS: {player.assignedTo?.name ?? t("not assigned")}</span>
          {staff.length > 0 ? (
            <Dialog label={t("Assign CS")} title={t("Assign CS")}>
              <ActionForm action={assignPlayer} close className="space-y-3">
                <input type="hidden" name="playerId" value={id} />
                <select name="staffId" className="input" defaultValue={player.assignedToId ?? ""}>
                  <option value="">{t("Nobody")}</option>
                  {staff.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
                <div className="flex justify-end">
                  <Submit>{t("Assign")}</Submit>
                </div>
              </ActionForm>
            </Dialog>
          ) : (
            canLog &&
            !player.assignedToId && (
              <ActionButton action={assignPlayer} fields={{ playerId: id, staffId: "me" }}>
                {t("Assign to me")}
              </ActionButton>
            )
          )}
          {canEdit && (
            <Dialog label={t("Edit details")} title={t("Edit {name}", { name: player.username })}>
              <ActionForm action={updatePlayer} close className="space-y-3">
                <input type="hidden" name="id" value={id} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Phone")} hint={t("Used to find the same person in other brands")}>
                    <input name="phone" className="input" defaultValue={player.phone ?? ""} />
                  </Field>
                  <Field label={t("Name")}>
                    <input name="name" className="input" defaultValue={player.name ?? ""} />
                  </Field>
                </div>
                <Field label={t("Note")}>
                  <input name="note" className="input" defaultValue={player.note ?? ""} maxLength={250} />
                </Field>
                <div className="flex justify-end">
                  <Submit>{t("Save")}</Submit>
                </div>
              </ActionForm>
            </Dialog>
          )}
          {canLog && (
            <Dialog label={"+ " + t("Log contact")} title={t("Log contact: {name}", { name: player.username })} className="btn btn-primary btn-sm">
              <ContactForm playerId={id} channels={settings.csChannels} templates={settings.csTemplates} promos={promos} who={lastOther ? { name: lastOther.staff.name, when: ago(lastOther.contactedAt, t) } : null} />
            </Dialog>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          [t("Lifetime deposits"), money0(dep, cur), t("{n} deposits", { n: player.depositCount })],
          [t("Lifetime withdrawals"), money0(wd, cur), t("{n} withdrawals", { n: player.withdrawCount })],
          [t("Net (deposit − withdrawal)"), money0(dep - wd, cur), dep - wd < 0 ? t("Player is ahead") : t("Company is ahead")],
          [t("Average deposit"), player.depositCount ? money0(dep / player.depositCount, cur) : "–", ""],
          [t("First deposit"), d10(player.firstDepositAt), ""],
          [t("Last deposit"), d10(player.lastDepositAt), ago(player.lastDepositAt, t)],
        ].map(([label, value, sub]) => (
          <div key={label} className="card p-3.5">
            <div className="text-xs text-ink-2">{label}</div>
            <div className="mt-1 text-lg font-semibold">{value}</div>
            {sub && <div className="text-xs text-muted">{sub}</div>}
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title={t("Score breakdown")}
          note={`${tier.score} / 100 → ${t(tier.tier)}`}
          action={
            <Info>
              {t("Each part is measured against its “full marks” value and weighted. Change the values under Settings → Player tiers.")}
            </Info>
          }
        >
          <ul className="space-y-2.5 text-sm">
            {[
              [t("Total deposits"), dep, s.amountFull, s.weightAmount, money0(dep, cur), money0(s.amountFull, cur)],
              [t("Number of deposits"), player.depositCount, s.countFull, s.weightCount, String(player.depositCount), String(s.countFull)],
              [
                t("Average deposit"),
                player.depositCount ? dep / player.depositCount : 0,
                s.avgFull,
                s.weightAvg,
                player.depositCount ? money0(dep / player.depositCount, cur) : "–",
                money0(s.avgFull, cur),
              ],
            ].map(([label, v, full, w, shown, fullShown]) => {
              const p = Math.min(Number(v) / Number(full), 1);
              return (
                <li key={String(label)}>
                  <div className="flex justify-between text-xs">
                    <span>
                      {label} <span className="text-muted">({t("weight")} {String(w)})</span>
                    </span>
                    <span className="text-ink-2">
                      {String(shown)} / {String(fullShown)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-[var(--series-1)]" style={{ width: `${p * 100}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title={t("Same person in other brands")} note={t("Matched by phone number")}>
          {!player.phone ? (
            <p className="text-sm text-ink-2">{t("No phone number on file, so other brands can't be checked.")}</p>
          ) : visibleTwins.length === 0 ? (
            <p className="text-sm text-ink-2">{t("Not found in any other brand you can see.")}</p>
          ) : (
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("Brand")}</th>
                    <th>{t("Username")}</th>
                    <th className="r">{t("Deposits")}</th>
                    <th className="r">{t("Withdrawals")}</th>
                    <th>{t("Last deposit")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-brand-soft/40">
                    <td className="font-medium">{player.brand.name}</td>
                    <td>{player.username}</td>
                    <td className="r">{money0(dep, cur)}</td>
                    <td className="r">{money0(wd, cur)}</td>
                    <td>{d10(player.lastDepositAt)}</td>
                  </tr>
                  {visibleTwins.map((t) => (
                    <tr key={t.id}>
                      <td className="font-medium">{t.brand.name}</td>
                      <td>
                        <Link className="hover:underline" href={`/players/${t.id}`}>
                          {t.username}
                        </Link>
                      </td>
                      <td className="r">{money0(t.depositTotal, t.brand.currency)}</td>
                      <td className="r">{money0(t.withdrawTotal, t.brand.currency)}</td>
                      <td>{d10(t.lastDepositAt)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>{t("All brands")} ({settings.baseCurrency})</td>
                    <td className="r">{money0(crossTotal.dep, settings.baseCurrency)}</td>
                    <td className="r">{money0(crossTotal.wd, settings.baseCurrency)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card title={t("Last 12 months")}>
        {byMonth.size === 0 ? (
          <p className="text-sm text-ink-2">{t("No transactions in the last 12 months.")}</p>
        ) : (
          <div className="space-y-1.5">
            {[...byMonth.entries()].map(([m, v]) => (
              <div key={m} className="grid grid-cols-[4.5rem_1fr_7rem] items-center gap-3 text-xs tabular-nums">
                <span className="text-ink-2">{m}</span>
                <div className="space-y-0.5">
                  <div className="h-2 rounded-r-[4px] bg-[var(--series-1)]" style={{ width: `${(v.dep / monthMax) * 100}%` }} title={`${t("Deposits")} ${money0(v.dep, cur)}`} />
                  <div className="h-2 rounded-r-[4px] bg-[var(--series-2)]" style={{ width: `${(v.wd / monthMax) * 100}%` }} title={`${t("Withdrawals")} ${money0(v.wd, cur)}`} />
                </div>
                <span className="text-right">
                  {money0(v.dep, cur)}
                  <br />
                  <span className="text-muted">{money0(v.wd, cur)}</span>
                </span>
              </div>
            ))}
            <div className="flex gap-4 pt-2 text-xs text-ink-2">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-sm bg-[var(--series-1)]" /> {t("Deposits")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-sm bg-[var(--series-2)]" /> {t("Withdrawals")}
              </span>
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          flush
          title={t("Transactions")}
          note={t("Latest 50")}
          action={
            firstTxn &&
            can(user, "transactions") && (
              <Link className="btn btn-sm" href={`/transactions?${new URLSearchParams({ player: String(id), from: dayOf(firstTxn.txnAt), to: todayStr() })}`}>
                {t("See all")} →
              </Link>
            )
          }
        >
          {txns.length === 0 ? (
            <Empty title={t("No transactions")} />
          ) : (
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("Time")}</th>
                    <th>{t("Type")}</th>
                    <th className="r">{t("Amount")}</th>
                    <th>{t("PG / bank")}</th>
                    <th>{t("Entered by")}</th>
                  </tr>
                </thead>
                <tbody>
                  {txns.map((tx) => (
                    <tr key={tx.id}>
                      <td className="whitespace-nowrap text-ink-2">{dt(tx.txnAt)}</td>
                      <td>{tx.type === "DEPOSIT" ? <Chip tone="good">{t("Deposit")}</Chip> : <Chip tone="warning">{t("Withdrawal")}</Chip>}</td>
                      <td className="r">{money(tx.amount, cur)}</td>
                      <td className="text-ink-2">{tx.channel?.name ?? "–"}</td>
                      <td className="whitespace-nowrap text-ink-2">{tx.createdBy?.name ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
        <div className="space-y-5">
          <Card flush title={t("Contact history")}>
            {contacts.length === 0 ? (
              <Empty title={t("Nobody has contacted this player yet")} />
            ) : (
              <ul className="divide-y divide-[var(--line)]">
                {contacts.map((c) => (
                  <li key={c.id} className="flex gap-3 px-4 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div>
                        <b>{c.staff.name}</b> · {t(c.channel)}
                        {c.replied ? <Chip tone="good">{t("Replied")}</Chip> : <Chip>{t("No reply")}</Chip>}
                      </div>
                      <div className="text-xs text-ink-2">
                        {dt(c.contactedAt)}
                        {c.promotion && ` · ${t("Offer")}: ${c.promotion.name}`}
                        {n(c.bonus) > 0 && ` · ${t("Bonus")} ${money(c.bonus, cur)}`}
                      </div>
                      {c.result && <div className="mt-0.5 text-ink-2">{c.result}</div>}
                      {c.message && <div className="mt-1 rounded-md bg-surface-2 px-2 py-1 text-xs whitespace-pre-wrap text-ink-2">{c.message}</div>}
                      {c.recalledAt && (
                        <div className="mt-1">
                          <Chip tone="good">
                            {t("Recalled")}: {money(c.recallAmount ?? 0, cur)} · {dt(c.recalledAt)}
                          </Chip>
                        </div>
                      )}
                    </div>
                    {csRights.may(c.staffId, c.createdAt) && (
                      <ActionButton action={deleteContact} fields={{ id: c.id }} question={t("Delete this contact record?")} className="btn btn-ghost btn-sm text-muted">
                        ✕
                      </ActionButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {(tracking.length > 0 || openAwards.length > 0) && (
            <Card flush title={t("Promotion progress")} note={t("Current periods")}>
              <ul className="divide-y divide-[var(--line)] text-sm">
                {tracking.map(({ p, rule, next }) => (
                  <li key={p.id} className="px-4 py-2.5">
                    <Link className="link font-medium" href={`/promotions/${p.promotionId}`}>
                      {p.promotion.name}
                    </Link>
                    <div className="text-xs text-ink-2">
                      {next < 0
                        ? t("All tiers reached")
                        : t("Tier {n}", { n: next + 1 }) + ": " + progressText(rule, rule.tiers[next], n(p.amount), p.count, t, cur)}
                    </div>
                  </li>
                ))}
                {openAwards.map((a) => (
                  <li key={"a" + a.id} className="flex items-center gap-2 px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate">{a.promotion.name}</span>
                    <Chip tone="warning">
                      {money(a.bonus, cur)} · {a.eligibleAt > new Date() ? t("From next period") : t("Not claimed yet")}
                    </Chip>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {boxes.length > 0 && (
            <Card flush title={t("Lucky Box")} action={<Link className="link text-sm" href={`/lucky-box?q=${encodeURIComponent(player.username)}&status=all`}>{t("Open")}</Link>}>
              <ul className="divide-y divide-[var(--line)] text-sm">
                {boxes.map((b) => (
                  <li key={b.promotionId} className="flex items-center gap-2 px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate">{boxName.get(b.promotionId)}</span>
                    <span className="font-medium">{money(b.balance, cur)}</span>
                    {b.ready && <Chip tone="good">{t("Release {amount}", { amount: money(b.ready.amount, cur) })}</Chip>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card flush title={t("Promotion claims")} note={t("Latest 20")}>
            {claims.length === 0 ? (
              <Empty title={t("No promotions claimed")} />
            ) : (
              <TableWrap>
                <table className="tbl">
                  <tbody>
                    {claims.map((c) => (
                      <tr key={c.id}>
                        <td className="whitespace-nowrap text-ink-2">{dt(c.claimedAt)}</td>
                        <td>{c.promotion.name}</td>
                        <td className="r">{money(c.amount, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
