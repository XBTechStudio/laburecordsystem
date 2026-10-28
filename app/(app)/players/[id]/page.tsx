import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, ActionForm, Dialog, Submit } from "@/components/client";
import { ContactForm } from "@/components/contact-form";
import { TierChip } from "@/components/tier";
import { Card, Chip, Empty, Field, Info, TableWrap } from "@/components/ui";
import { can, canSeeBrand, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ago, d10, dt, money, money0, n } from "@/lib/format";
import { getSettings, scorePlayer } from "@/lib/settings";
import { assignPlayer, deleteContact } from "../../cs/actions";
import { updatePlayer } from "../actions";
import { getT } from "@/lib/i18n-server";

function daysAgo(days: number) {
  return Date.now() - days * 86400_000;
}

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePage("players");
  const id = Number((await params).id);
  const player = Number.isInteger(id) ? await prisma.player.findUnique({ where: { id }, include: { brand: true, assignedTo: true } }) : null;
  if (!player || !canSeeBrand(user, player.brandId)) notFound();

  const [settings, t] = await Promise.all([getSettings(), getT()]);
  const cur = player.brand.currency;
  const dep = n(player.depositTotal);
  const wd = n(player.withdrawTotal);
  const tier = scorePlayer(settings.tierScoring, dep, player.depositCount);
  const s = settings.tierScoring;
  const canEdit = can(user, "players", 3);
  const canLog = can(user, "cs", 2) || can(user, "churn", 2);

  const [txns, claims, contacts, twins, months, promos, staff] = await Promise.all([
    prisma.txn.findMany({ where: { playerId: id }, include: { channel: true }, orderBy: { txnAt: "desc" }, take: 50 }),
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
  ]);
  const visibleTwins = twins.filter((t) => canSeeBrand(user, t.brandId));
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
              <ContactForm playerId={id} channels={settings.csChannels} promos={promos} who={lastOther ? { name: lastOther.staff.name, when: ago(lastOther.contactedAt, t) } : null} />
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
        <Card flush title={t("Transactions")} note={t("Latest 50")}>
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
                  </tr>
                </thead>
                <tbody>
                  {txns.map((tx) => (
                    <tr key={tx.id}>
                      <td className="whitespace-nowrap text-ink-2">{dt(tx.txnAt)}</td>
                      <td>{tx.type === "DEPOSIT" ? <Chip tone="good">{t("Deposit")}</Chip> : <Chip tone="warning">{t("Withdrawal")}</Chip>}</td>
                      <td className="r">{money(tx.amount, cur)}</td>
                      <td className="text-ink-2">{tx.channel?.name ?? "–"}</td>
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
                    </div>
                    {(can(user, "cs", 3) || c.staffId === user.id) && (
                      <ActionButton action={deleteContact} fields={{ id: c.id }} question={t("Delete this contact record?")} className="btn btn-ghost btn-sm text-muted">
                        ✕
                      </ActionButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
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
