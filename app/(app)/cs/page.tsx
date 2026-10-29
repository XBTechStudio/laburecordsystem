import Link from "next/link";
import { MessageField } from "@/components/message-field";
import { Prisma } from "@prisma/client";
import { ActionButton, ActionForm, AutoSelect, Dialog, Submit } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Chip, Empty, Field, Info, PageHeader, Pager, TableWrap, Tabs } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { addDays, allDaysOf, dayStart, instantRange, parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { editRights } from "@/lib/edit-rights";
import { count, dt, money, money0, n, pct, ratio } from "@/lib/format";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import type { T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { deleteContact, logContact } from "./actions";

type Row = { id: number; staffId: number; playerId: number; channel: string; replied: number; bonus: unknown; brandId: number; dep: unknown; d: string };

type Agg = { contacts: number; players: Set<number>; replied: number; returned: Set<number>; deposits: number; bonus: number };
const agg = (): Agg => ({ contacts: 0, players: new Set(), replied: 0, returned: new Set(), deposits: 0, bonus: 0 });

export default async function CsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("cs");
  const sp = await searchParams;
  const tab = sp.tab === "log" ? "log" : "performance";
  const range = parseRange(sp, "month");
  const [scope, settings, t, rights] = await Promise.all([getScope(user), getSettings(), getT(), editRights(user, "cs")]);
  const canLog = can(user, "cs", 2);

  return (
    <div className="max-w-7xl">
      <PageHeader
        title={t("CS recall tracking")}
        desc={
          <>
            {t("Who contacted which players, and how many came back.")}{" "}
            <Info>
              {t("A contacted player counts as returned if they make a deposit within {n} days after the contact (Settings → Churn & CS). Deposits shown are what they deposited in that window.", { n: settings.recallDays })}
            </Info>
          </>
        }
        actions={
          canLog && (
            <Dialog label={"+ " + t("Log contact")} title={t("Log a contact")} className="btn btn-primary">
              <ActionForm action={logContact} close className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Brand")}>
                    <select name="brandId" className="input" defaultValue={scope.current?.id ?? scope.brands[0]?.id} required>
                      {scope.brands.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("Player username")}>
                    <input name="username" className="input" required />
                  </Field>
                  <Field label={t("Channel")}>
                    <select name="channel" className="input">
                      {settings.csChannels.map((c) => (
                        <option key={c} value={c}>
                          {t(c)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("Bonus given")}>
                    <input name="bonus" className="input" inputMode="decimal" placeholder="0" />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="replied" className="h-4 w-4 accent-[var(--brand)]" /> {t("Player replied")}
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input type="checkbox" name="confirmDup" className="h-4 w-4" /> {t("Log even if another CS contacted them recently")}
                </label>
                <MessageField templates={settings.csTemplates} />
                <Field label={t("Result / note")}>
                  <input name="result" className="input" maxLength={250} />
                </Field>
                <div className="flex justify-end">
                  <Submit>{t("Log contact")}</Submit>
                </div>
              </ActionForm>
            </Dialog>
          )
        }
      />
      <Tabs
        items={[
          { href: `/cs?${new URLSearchParams({ ...clean(sp), tab: "performance" })}`, label: t("Performance"), active: tab === "performance" },
          { href: `/cs?${new URLSearchParams({ ...clean(sp), tab: "log" })}`, label: t("Contact log"), active: tab === "log" },
        ]}
      />
      <div className="mb-4">
        <RangeBar path="/cs" range={range} params={{ ...sp, tab }} />
      </div>
      {tab === "performance" ? (
        <Performance brandIds={scope.brandIds} range={range} recallDays={settings.recallDays} recallMin={settings.recallMinAmount} rate={scope.rate} currency={scope.currency} brandName={scope.brandName} t={t} />
      ) : (
        <Log sp={sp} brandIds={scope.brandIds} range={range} may={rights.may} note={rights.note} brandCurrency={scope.brandCurrency} t={t} />
      )}
    </div>
  );
}

const clean = (sp: Record<string, string | undefined>) => Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "page" && k !== "tab")) as Record<string, string>;

async function Performance({
  brandIds,
  range,
  recallDays,
  recallMin,
  rate,
  currency,
  brandName,
  t,
}: {
  brandIds: number[];
  range: { from: string; to: string };
  recallDays: number;
  recallMin: number;
  rate: (id: number) => number;
  currency: string;
  brandName: (id: number) => string;
  t: T;
}) {
  if (!brandIds.length) return null;
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT c.id, c.staffId, c.playerId, c.channel, c.replied, c.bonus, p.brandId,
      DATE_FORMAT(DATE_ADD(c.contactedAt, INTERVAL 8 HOUR), '%Y-%m-%d') AS d,
      (SELECT COALESCE(SUM(t.amount), 0) FROM \`Txn\` t
        WHERE t.playerId = c.playerId AND t.type = 'DEPOSIT' AND t.amount >= ${recallMin} AND t.txnAt > c.contactedAt AND t.txnAt <= DATE_ADD(c.contactedAt, INTERVAL ${recallDays} DAY)) AS dep
    FROM \`ContactLog\` c JOIN \`Player\` p ON p.id = c.playerId
    WHERE p.brandId IN (${Prisma.join(brandIds)}) AND c.contactedAt >= ${dayStart(range.from)} AND c.contactedAt < ${dayStart(addDays(range.to, 1))}`;
  if (rows.length === 0)
    return (
      <Card>
        <Empty title={t("No contacts logged in this period")}>{t("Contacts are logged from Churn follow-up, a player's page, or the button above.")}</Empty>
      </Card>
    );

  const users = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const byStaff = new Map<number, Agg>();
  const byChannel = new Map<string, Agg>();
  const byBrand = new Map<number, Agg>();
  const daily = new Map<string, number>();
  // Deposits are counted once per staff + player (their best window), so contacting someone twice doesn't double it.
  const best = new Map<string, number>();
  const add = (a: Agg, r: Row, dep: number, bonus: number) => {
    a.contacts++;
    a.players.add(r.playerId);
    if (Number(r.replied)) a.replied++;
    a.bonus += bonus;
    if (dep > 0) a.returned.add(r.playerId);
    return a;
  };
  for (const r of rows) {
    const dep = n(r.dep as number) * rate(r.brandId);
    const bonus = n(r.bonus as number) * rate(r.brandId);
    byStaff.set(r.staffId, add(byStaff.get(r.staffId) ?? agg(), r, dep, bonus));
    byChannel.set(r.channel, add(byChannel.get(r.channel) ?? agg(), r, dep, bonus));
    byBrand.set(r.brandId, add(byBrand.get(r.brandId) ?? agg(), r, dep, bonus));
    for (const k of [`s${r.staffId}|${r.playerId}`, `c${r.channel}|${r.playerId}`, `b${r.brandId}|${r.playerId}`]) best.set(k, Math.max(best.get(k) ?? 0, dep));
    daily.set(`${r.staffId}|${r.d}`, (daily.get(`${r.staffId}|${r.d}`) ?? 0) + 1);
  }
  for (const [k, v] of best) {
    const [key] = k.slice(1).split("|");
    const a = k[0] === "s" ? byStaff.get(Number(key)) : k[0] === "b" ? byBrand.get(Number(key)) : byChannel.get(key);
    if (a) a.deposits += v;
  }

  const staffRows = [...byStaff.entries()].sort((a, b) => b[1].returned.size - a[1].returned.size);
  const days = allDaysOf(range).slice(-31);
  const table = (title: string, entries: [string, Agg][], first: string) => (
    <Card flush title={title}>
      <TableWrap>
        <table className="tbl">
          <thead>
            <tr>
              <th>{first}</th>
              <th className="r">{t("Contacts")}</th>
              <th className="r">{t("Players")}</th>
              <th className="r">{t("Replied")}</th>
              <th className="r">{t("Returned")}</th>
              <th className="r">{t("Return rate")}</th>
              <th className="r">{t("Deposits after contact")}</th>
              <th className="r">{t("Bonus given")}</th>
              <th className="r">
                {t("Return per 1 bonus")} <Info>{t("Deposits after contact ÷ bonus given. Higher is better.")}</Info>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([name, a]) => (
              <tr key={name}>
                <td className="font-medium">{t(name)}</td>
                <td className="r">{count(a.contacts)}</td>
                <td className="r">{count(a.players.size)}</td>
                <td className="r">{pct(ratio(a.replied, a.contacts), 0)}</td>
                <td className="r font-medium">{count(a.returned.size)}</td>
                <td className="r">{pct(ratio(a.returned.size, a.players.size), 0)}</td>
                <td className="r">{money0(a.deposits, currency)}</td>
                <td className="r">{money0(a.bonus, currency)}</td>
                <td className="r">{a.bonus ? (a.deposits / a.bonus).toFixed(1) + "×" : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );

  return (
    <div className="space-y-5">
      {table(t("By CS"), staffRows.map(([id, a]) => [users.get(id) ?? `#${id}`, a]), t("Staff"))}
      {byBrand.size > 1 && table(t("By brand"), [...byBrand.entries()].sort((a, b) => b[1].players.size - a[1].players.size).map(([id, a]) => [brandName(id), a]), t("Brand"))}
      {table(t("By channel"), [...byChannel.entries()].sort((a, b) => b[1].contacts - a[1].contacts), t("Channel"))}
      <Card flush title={t("Contacts per day")} note={days.length < allDaysOf(range).length ? t("Last 31 days of the period") : undefined}>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("Staff")}</th>
                {days.map((d) => (
                  <th key={d} className="text-center">
                    {d.slice(8)}
                  </th>
                ))}
                <th className="r">{t("Total")}</th>
              </tr>
            </thead>
            <tbody>
              {staffRows.map(([id, a]) => (
                <tr key={id}>
                  <td className="font-medium whitespace-nowrap">{users.get(id)}</td>
                  {days.map((d) => {
                    const v = daily.get(`${id}|${d}`) ?? 0;
                    return (
                      <td key={d} className={`text-center ${v ? "" : "text-muted"}`}>
                        {v || "·"}
                      </td>
                    );
                  })}
                  <td className="r font-medium">{a.contacts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </div>
  );
}

async function Log({
  sp,
  brandIds,
  range,
  may,
  note,
  brandCurrency,
  t,
}: {
  sp: Record<string, string | undefined>;
  brandIds: number[];
  range: { from: string; to: string };
  may: (authorId: number | null, createdAt: Date) => boolean;
  note: string;
  brandCurrency: (id: number) => string;
  t: T;
}) {
  const page = Math.max(1, Number(sp.page) || 1);
  const where = {
    player: { brandId: { in: brandIds } },
    contactedAt: instantRange(range),
    ...(sp.staff ? { staffId: Number(sp.staff) } : {}),
    ...(sp.replied ? { replied: sp.replied === "yes" } : {}),
  };
  const [rows, total, staff] = await Promise.all([
    prisma.contactLog.findMany({ where, include: { player: true, staff: true, promotion: true }, orderBy: { contactedAt: "desc" }, take: 50, skip: (page - 1) * 50 }),
    prisma.contactLog.count({ where }),
    prisma.user.findMany({ where: { contacts: { some: {} } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const keep = clean({ ...sp, tab: undefined });
  return (
    <Card
      flush
      title={t("{n} contacts", { n: count(total) })}
      note={note || undefined}
      action={
        <form action="/cs" className="flex gap-2">
          <input type="hidden" name="tab" value="log" />
          {Object.entries(keep)
            .filter(([k]) => ["from", "to", "preset"].includes(k))
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <AutoSelect name="staff" defaultValue={sp.staff ?? ""} className="input h-8 w-auto">
            <option value="">{t("All staff")}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </AutoSelect>
          <AutoSelect name="replied" defaultValue={sp.replied ?? ""} className="input h-8 w-auto">
            <option value="">{t("Replied or not")}</option>
            <option value="yes">{t("Replied")}</option>
            <option value="no">{t("No reply")}</option>
          </AutoSelect>
        </form>
      }
    >
      {rows.length === 0 ? (
        <Empty title={t("No contacts in this period")} />
      ) : (
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("When")}</th>
                <th>{t("Staff")}</th>
                <th>{t("Player")}</th>
                <th>{t("Channel")}</th>
                <th>{t("Offer")}</th>
                <th className="r">{t("Bonus")}</th>
                <th>{t("Reply")}</th>
                <th>{t("Result")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap text-ink-2">{dt(c.contactedAt)}</td>
                  <td>{c.staff.name}</td>
                  <td>
                    <Link className="font-medium hover:underline" href={`/players/${c.playerId}`}>
                      {c.player.username}
                    </Link>
                  </td>
                  <td>{t(c.channel)}</td>
                  <td className="text-ink-2">{c.promotion?.name ?? "–"}</td>
                  <td className="r">{n(c.bonus) ? money(c.bonus, brandCurrency(c.player.brandId)) : "–"}</td>
                  <td>{c.replied ? <Chip tone="good">{t("Replied")}</Chip> : <Chip>{t("No reply")}</Chip>}</td>
                  <td className="max-w-64 truncate text-ink-2">{c.result ?? ""}</td>
                  <td className="r">
                    {may(c.staffId, c.createdAt) && (
                      <ActionButton action={deleteContact} fields={{ id: c.id }} question={t("Delete this contact record?")}>
                        {t("Delete")}
                      </ActionButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <Pager page={page} pages={Math.ceil(total / 50)} href={(p) => `/cs?${new URLSearchParams({ ...keep, tab: "log", page: String(p) })}`} />
    </Card>
  );
}
