import Link from "next/link";
import type { ReactNode } from "react";
import { BatchEntry, type Col } from "@/components/batch-entry";
import { ActionButton, ActionForm, AutoSelect, Dialog, Submit } from "@/components/client";
import { Card, Chip, Empty, Field, PageHeader, TableWrap, Tabs } from "@/components/ui";
import { can, requirePage, type CurrentUser } from "@/lib/auth";
import { dayStart, addDays, toLocalInput, todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { d10, dt, money, n } from "@/lib/format";
import { tk, type T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { getScope } from "@/lib/scope";
import { deleteEntry, loadLists, saveBatch, updateEntry } from "./actions";

const KINDS = [
  { key: "txn", label: tk("Deposits & withdrawals") },
  { key: "flow", label: tk("PG & bank statements") },
  { key: "claim", label: tk("Promotion claims") },
  { key: "player", label: tk("Players") },
] as const;
type Kind = (typeof KINDS)[number]["key"];

const TYPE_ALIASES = {
  d: "DEPOSIT",
  dep: "DEPOSIT",
  deposit: "DEPOSIT",
  in: "DEPOSIT",
  充值: "DEPOSIT",
  存款: "DEPOSIT",
  w: "WITHDRAW",
  wd: "WITHDRAW",
  withdraw: "WITHDRAW",
  withdrawal: "WITHDRAW",
  out: "WITHDRAW",
  提款: "WITHDRAW",
  取款: "WITHDRAW",
};

export default async function EntryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("entry", 2);
  const sp = await searchParams;
  const kind: Kind = KINDS.find((k) => k.key === sp.kind)?.key ?? "txn";
  const [scope, t] = await Promise.all([getScope(user), getT()]);
  const channels = await prisma.payChannel.findMany({ where: { active: true }, orderBy: [{ type: "asc" }, { name: "asc" }] });
  const chOpts = channels.map((c) => ({ value: String(c.id), label: c.name }));

  const cols: Record<Kind, Col[]> = {
    txn: [
      { key: "player", label: t("Player username"), type: "player", required: true, width: "11rem" },
      {
        key: "type",
        label: t("Type"),
        type: "select",
        required: true,
        width: "8rem",
        options: [
          { value: "DEPOSIT", label: t("Deposit") },
          { value: "WITHDRAW", label: t("Withdrawal") },
        ],
        aliases: TYPE_ALIASES,
      },
      { key: "amount", label: t("Amount"), type: "amount", required: true, width: "7rem" },
      { key: "time", label: t("Date & time"), type: "datetime", width: "11rem" },
      { key: "channel", label: t("PG / bank"), type: "select", options: chOpts, width: "9rem" },
      { key: "ref", label: t("Reference no."), type: "text", width: "9rem", placeholder: t("optional") },
      { key: "note", label: t("Note"), type: "text", width: "9rem" },
    ],
    flow: [
      { key: "channel", label: t("PG / bank"), type: "select", required: true, options: chOpts, width: "10rem" },
      { key: "date", label: t("Date"), type: "date", width: "9rem" },
      { key: "inAmount", label: t("Money in"), type: "amount", width: "7rem" },
      { key: "inCount", label: t("In count"), type: "int", width: "5rem" },
      { key: "outAmount", label: t("Money out"), type: "amount", width: "7rem" },
      { key: "outCount", label: t("Out count"), type: "int", width: "5rem" },
      { key: "fee", label: t("Fee"), type: "amount", width: "6rem", placeholder: t("auto") },
      { key: "note", label: t("Note"), type: "text", width: "9rem" },
    ],
    claim: [
      { key: "player", label: t("Player username"), type: "player", required: true, width: "11rem" },
      { key: "promo", label: t("Promotion"), type: "combo", list: "promos", required: true, width: "12rem", placeholder: t("pick or type a new one") },
      { key: "amount", label: t("Bonus amount"), type: "amount", required: true, width: "7rem" },
      { key: "time", label: t("Date & time"), type: "datetime", width: "11rem" },
    ],
    player: [
      { key: "username", label: t("Username"), type: "text", required: true, width: "11rem" },
      { key: "phone", label: t("Phone"), type: "text", width: "9rem" },
      { key: "name", label: t("Name"), type: "text", width: "10rem" },
      { key: "note", label: t("Note"), type: "text", width: "12rem" },
    ],
  };

  const notes: Record<Kind, string> = {
    txn: t("New usernames are created as players automatically."),
    flow: t("One row per PG/bank per day, as shown on the statement. Leave Fee empty to calculate it from the channel's fee rate. Entering the same day again replaces it."),
    claim: t("Type a promotion name that doesn't exist yet and it will be created."),
    player: t("Existing usernames are updated with the phone/name/note you enter."),
  };

  if (kind === "flow" && channels.length === 0) {
    return (
      <Shell kind={kind} t={t}>
        <Card>
          <Empty title={t("Add your PG and bank channels first")}>
            {t("Statements are entered per payment gateway or bank account.")}{" "}
            {can(user, "settings", 3) ? (
              <Link className="link" href="/admin/settings?tab=channels">
                {t("Add channels in Settings")}
              </Link>
            ) : (
              t("Ask an administrator to add them in Settings.")
            )}
          </Empty>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell kind={kind} t={t}>
      <BatchEntry
        key={kind}
        kind={kind}
        cols={cols[kind]}
        brands={scope.brands.map((b) => ({ id: b.id, name: b.name, currency: b.currency }))}
        brandId={scope.current?.id ?? (scope.brands.length === 1 ? scope.brands[0].id : null)}
        save={saveBatch}
        loadLists={loadLists}
        note={notes[kind]}
        totals={
          kind === "txn"
            ? [{ col: "amount", label: "", split: { by: "type", values: { DEPOSIT: t("Deposits"), WITHDRAW: t("Withdrawals") } } }]
            : kind === "flow"
              ? [
                  { col: "inAmount", label: t("In") },
                  { col: "outAmount", label: t("Out") },
                ]
              : kind === "claim"
                ? [{ col: "amount", label: t("Bonus") }]
                : []
        }
      />
      <Recent user={user} kind={kind} sp={sp} brandIds={scope.brandIds} channels={chOpts} brandCurrency={scope.brandCurrency} brandName={scope.brandName} multi={!scope.current} />
    </Shell>
  );
}

/** Entries newer than this can still be fixed by the person who made them. */
function anHourAgo() {
  return Date.now() - 3600_000;
}

function Shell({ kind, children, t }: { kind: Kind; children: ReactNode; t: T }) {
  return (
    <div className="max-w-6xl space-y-5">
      <div>
        <PageHeader
          title={t("Data entry")}
          desc={t("Enter a day's data in one go. You can also upload a whole file in Excel import.")}
          actions={
            <Link href="/import" className="btn">
              {t("Excel import")} →
            </Link>
          }
        />
        <Tabs items={KINDS.map((k) => ({ href: `/entry?kind=${k.key}`, label: t(k.label), active: k.key === kind }))} />
      </div>
      {children}
    </div>
  );
}

async function Recent({
  user,
  kind,
  sp,
  brandIds,
  channels,
  brandCurrency,
  brandName,
  multi,
}: {
  user: CurrentUser;
  kind: Kind;
  sp: Record<string, string | undefined>;
  brandIds: number[];
  channels: { value: string; label: string }[];
  brandCurrency: (id: number) => string;
  brandName: (id: number) => string;
  multi: boolean;
}) {
  const t = await getT();
  const full = can(user, "entry", 3);
  const who = full && sp.who === "all" ? "all" : "me";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? "") ? sp.day! : todayStr();
  const created = { gte: dayStart(day), lt: dayStart(addDays(day, 1)) };
  const mine = who === "me" ? { createdById: user.id } : {};
  const recentHour = anHourAgo();
  const canChange = (createdById: number | null, createdAt: Date) => full || (createdById === user.id && createdAt.getTime() > recentHour);
  const actions = (id: number, allowed: boolean, form: ReactNode, label: string) =>
    allowed ? (
      <td className="r space-x-1">
        <Dialog label={t("Edit")} title={t("Edit {name}", { name: label })}>
          <ActionForm action={updateEntry} close className="space-y-3">
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="id" value={id} />
            {form}
            <div className="flex justify-end">
              <Submit>{t("Save")}</Submit>
            </div>
          </ActionForm>
        </Dialog>
        <ActionButton action={deleteEntry} fields={{ kind, id }} question={t("Delete this {name}? This can't be undone.", { name: label })}>
          {t("Delete")}
        </ActionButton>
      </td>
    ) : (
      <td />
    );

  let table: ReactNode = null;
  let total = 0;

  if (kind === "txn") {
    const rows = await prisma.txn.findMany({
      where: { brandId: { in: brandIds }, createdAt: created, ...mine },
      include: { player: true, channel: true },
      orderBy: { id: "desc" },
      take: 200,
    });
    total = rows.length;
    table = (
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("Player")}</th>
            {multi && <th>{t("Brand")}</th>}
            <th>{t("Type")}</th>
            <th className="r">{t("Amount")}</th>
            <th>{t("Time")}</th>
            <th>{t("PG / bank")}</th>
            <th>{t("Ref")}</th>
            <th>{t("Note")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((tx) => (
            <tr key={tx.id}>
              <td className="font-medium">
                <Link className="hover:underline" href={`/players/${tx.playerId}`}>
                  {tx.player.username}
                </Link>
              </td>
              {multi && <td className="text-ink-2">{brandName(tx.brandId)}</td>}
              <td>{tx.type === "DEPOSIT" ? <Chip tone="good">{t("Deposit")}</Chip> : <Chip tone="warning">{t("Withdrawal")}</Chip>}</td>
              <td className="r">{money(tx.amount, brandCurrency(tx.brandId))}</td>
              <td className="whitespace-nowrap text-ink-2">{dt(tx.txnAt)}</td>
              <td className="text-ink-2">{tx.channel?.name ?? "–"}</td>
              <td className="text-ink-2">{tx.ref ?? "–"}</td>
              <td className="max-w-48 truncate text-ink-2">{tx.note ?? ""}</td>
              {actions(
                tx.id,
                canChange(tx.createdById, tx.createdAt),
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("Type")}>
                      <select name="type" className="input" defaultValue={tx.type}>
                        <option value="DEPOSIT">{t("Deposit")}</option>
                        <option value="WITHDRAW">{t("Withdrawal")}</option>
                      </select>
                    </Field>
                    <Field label={t("Amount")}>
                      <input name="amount" className="input" defaultValue={n(tx.amount)} inputMode="decimal" required />
                    </Field>
                    <Field label={t("Date & time")}>
                      <input name="time" type="datetime-local" className="input" defaultValue={toLocalInput(tx.txnAt)} />
                    </Field>
                    <Field label={t("PG / bank")}>
                      <select name="channel" className="input" defaultValue={tx.channelId ?? ""}>
                        <option value="">–</option>
                        {channels.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t("Reference no.")}>
                      <input name="ref" className="input" defaultValue={tx.ref ?? ""} />
                    </Field>
                    <Field label={t("Note")}>
                      <input name="note" className="input" defaultValue={tx.note ?? ""} />
                    </Field>
                  </div>
                </>,
                t("transaction"),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (kind === "flow") {
    const rows = await prisma.channelFlow.findMany({
      where: { brandId: { in: brandIds }, createdAt: created, ...mine },
      include: { channel: true },
      orderBy: { id: "desc" },
      take: 200,
    });
    total = rows.length;
    table = (
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("Date")}</th>
            {multi && <th>{t("Brand")}</th>}
            <th>{t("PG / bank")}</th>
            <th className="r">{t("In")}</th>
            <th className="r">{t("Out")}</th>
            <th className="r">{t("Fee")}</th>
            <th>{t("Note")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id}>
              <td className="whitespace-nowrap">{d10(f.date)}</td>
              {multi && <td className="text-ink-2">{brandName(f.brandId)}</td>}
              <td className="font-medium">{f.channel.name}</td>
              <td className="r">
                {money(f.inAmount, brandCurrency(f.brandId))} <span className="text-xs text-muted">({f.inCount})</span>
              </td>
              <td className="r">
                {money(f.outAmount, brandCurrency(f.brandId))} <span className="text-xs text-muted">({f.outCount})</span>
              </td>
              <td className="r">{money(f.fee, brandCurrency(f.brandId))}</td>
              <td className="max-w-48 truncate text-ink-2">{f.note ?? ""}</td>
              {actions(
                f.id,
                canChange(f.createdById, f.createdAt),
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Money in")}>
                    <input name="inAmount" className="input" defaultValue={n(f.inAmount)} inputMode="decimal" />
                  </Field>
                  <Field label={t("In count")}>
                    <input name="inCount" className="input" defaultValue={f.inCount} inputMode="numeric" />
                  </Field>
                  <Field label={t("Money out")}>
                    <input name="outAmount" className="input" defaultValue={n(f.outAmount)} inputMode="decimal" />
                  </Field>
                  <Field label={t("Out count")}>
                    <input name="outCount" className="input" defaultValue={f.outCount} inputMode="numeric" />
                  </Field>
                  <Field label={t("Fee")}>
                    <input name="fee" className="input" defaultValue={n(f.fee)} inputMode="decimal" />
                  </Field>
                  <Field label={t("Note")}>
                    <input name="note" className="input" defaultValue={f.note ?? ""} />
                  </Field>
                </div>,
                t("statement row"),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (kind === "claim") {
    const rows = await prisma.promoClaim.findMany({
      where: { promotion: { brandId: { in: brandIds } }, createdAt: created, ...mine },
      include: { player: true, promotion: true },
      orderBy: { id: "desc" },
      take: 200,
    });
    total = rows.length;
    table = (
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("Player")}</th>
            {multi && <th>{t("Brand")}</th>}
            <th>{t("Promotion")}</th>
            <th className="r">{t("Bonus")}</th>
            <th>{t("Time")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="font-medium">{c.player.username}</td>
              {multi && <td className="text-ink-2">{brandName(c.promotion.brandId)}</td>}
              <td>{c.promotion.name}</td>
              <td className="r">{money(c.amount, brandCurrency(c.promotion.brandId))}</td>
              <td className="whitespace-nowrap text-ink-2">{dt(c.claimedAt)}</td>
              {actions(
                c.id,
                canChange(c.createdById, c.createdAt),
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Bonus amount")}>
                    <input name="amount" className="input" defaultValue={n(c.amount)} inputMode="decimal" />
                  </Field>
                  <Field label={t("Date & time")}>
                    <input name="time" type="datetime-local" className="input" defaultValue={toLocalInput(c.claimedAt)} />
                  </Field>
                </div>,
                t("claim"),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else {
    const rows = await prisma.player.findMany({
      where: { brandId: { in: brandIds }, createdAt: created },
      orderBy: { id: "desc" },
      take: 200,
    });
    total = rows.length;
    table = (
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("Username")}</th>
            {multi && <th>{t("Brand")}</th>}
            <th>{t("Phone")}</th>
            <th>{t("Name")}</th>
            <th>{t("Note")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="font-medium">
                <Link className="hover:underline" href={`/players/${p.id}`}>
                  {p.username}
                </Link>
              </td>
              {multi && <td className="text-ink-2">{brandName(p.brandId)}</td>}
              <td>{p.phone ?? "–"}</td>
              <td>{p.name ?? "–"}</td>
              <td className="max-w-56 truncate text-ink-2">{p.note ?? ""}</td>
              {actions(
                p.id,
                full,
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Phone")}>
                    <input name="phone" className="input" defaultValue={p.phone ?? ""} />
                  </Field>
                  <Field label={t("Name")}>
                    <input name="name" className="input" defaultValue={p.name ?? ""} />
                  </Field>
                  <Field label={t("Note")} className="col-span-2">
                    <input name="note" className="input" defaultValue={p.note ?? ""} />
                  </Field>
                </div>,
                t("player"),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <Card
      flush
      title={day === todayStr() ? t("Entered today") : t("Entered on {day}", { day })}
      note={`${total}${total === 200 ? "+" : ""} · ${who === "me" ? t("by you") : t("by everyone")}${full ? "" : " · " + t("you can fix your own entries for an hour after saving")}`}
      action={
        <form action="/entry" className="flex items-center gap-2">
          <input type="hidden" name="kind" value={kind} />
          {full && (
            <AutoSelect name="who" defaultValue={who} className="input h-8 w-auto">
              <option value="me">{t("By me")}</option>
              <option value="all">{t("By everyone")}</option>
            </AutoSelect>
          )}
          <input type="date" name="day" defaultValue={day} className="input h-8 w-auto" aria-label={t("Day")} />
          <button className="btn btn-sm h-8">{t("Show")}</button>
        </form>
      }
    >
      {total === 0 ? <Empty title={t("Nothing entered yet on this day")} /> : <TableWrap>{table}</TableWrap>}
    </Card>
  );
}
