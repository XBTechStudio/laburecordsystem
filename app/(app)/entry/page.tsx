import { BrandFilter } from "@/components/brand-filter";
import Link from "next/link";
import type { ReactNode } from "react";
import { BatchEntry, type Col } from "@/components/batch-entry";
import { AutoSelect } from "@/components/client";
import { Card, Chip, Empty, Field, PageHeader, TableWrap, Tabs } from "@/components/ui";
import { can, requirePage, type CurrentUser } from "@/lib/auth";
import { txnModule } from "@/lib/perms";
import { dayStart, addDays, toLocalInput, todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { editRights } from "@/lib/edit-rights";
import { dt, money, n } from "@/lib/format";
import { tk, type T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { loadLists, saveBatch } from "./actions";
import { EditCell, payTo, TxnFields } from "./edit-cell";

const KINDS = [
  { key: "txn", label: tk("Deposits & withdrawals") },
  { key: "claim", label: tk("Promotion claims") },
  { key: "box", label: tk("Lucky Box") },
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
  const [scope, t, settings] = await Promise.all([getScope(user), getT(), getSettings()]);
  const channels = await prisma.payChannel.findMany({ where: { active: true }, orderBy: [{ type: "asc" }, { name: "asc" }] });
  const chOpts = channels.map((c) => ({ value: String(c.id), label: c.name }));
  const chPick = channels.map((c) => ({ value: String(c.id), label: c.name, code: c.code }));

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
      { key: "channel", label: t("PG / bank"), type: "pick", required: true, options: chPick, width: "10rem", placeholder: t("code or name") },
      { key: "payBank", label: t("Withdrawal bank"), type: "text", width: "9rem", placeholder: t("optional") },
      { key: "payAccount", label: t("Account no."), type: "text", width: "9rem", placeholder: t("optional") },
      { key: "note", label: t("Note"), type: "text", width: "9rem" },
      { key: "ref", label: t("Reference no."), type: "text", width: "9rem", placeholder: t("optional") },
    ],
    claim: [
      { key: "player", label: t("Player username"), type: "player", required: true, width: "11rem" },
      { key: "promo", label: t("Promotion"), type: "combo", list: "promos", required: true, width: "12rem", placeholder: t("pick or type a new one") },
      { key: "amount", label: t("Bonus amount"), type: "amount", required: true, width: "7rem" },
      { key: "time", label: t("Date & time"), type: "datetime", width: "11rem" },
    ],
    box: [
      { key: "player", label: t("Player username"), type: "player", required: true, width: "11rem" },
      { key: "promo", label: t("Promotion"), type: "combo", list: "boxPromos", required: true, width: "12rem", placeholder: t("e.g. Daily FREE") },
      { key: "amount", label: t("Points into the box"), type: "amount", required: true, width: "8rem" },
      { key: "time", label: t("Date & time"), type: "datetime", width: "11rem" },
      { key: "note", label: t("Note"), type: "text", width: "12rem" },
    ],
    player: [
      { key: "username", label: t("Username"), type: "text", required: true, width: "11rem" },
      { key: "phone", label: t("Phone"), type: "text", width: "9rem" },
      { key: "name", label: t("Name"), type: "text", width: "10rem" },
      { key: "note", label: t("Note"), type: "text", width: "12rem" },
    ],
  };

  const notes: Record<Kind, string> = {
    txn: t("New usernames are created as players automatically. Choose the PG / bank so its balance stays right."),
    claim: t("Type a promotion name that doesn't exist yet and it will be created."),
    box: t("Winnings the player can't withdraw yet (e.g. Daily FREE). Take them off the player on the platform first. A new promotion name becomes a Lucky Box promotion."),
    player: t("Existing usernames are updated with the phone/name/note you enter."),
  };

  const shown = (c: Col[]) => (settings.entry.pickTime ? c : c.filter((x) => x.key !== "time"));
  const brands = scope.brands.map((b) => ({ id: b.id, name: b.name, currency: b.currency }));
  const brandId = scope.current?.id ?? (scope.brands.length === 1 ? scope.brands[0].id : null);
  // Deposits and withdrawals have a form each (staff may be allowed only one of them); withdrawals also take the player's bank.
  const txnCols = (type: "DEPOSIT" | "WITHDRAW") => shown(cols.txn.filter((c) => c.key !== "type" && (type === "WITHDRAW" || (c.key !== "payBank" && c.key !== "payAccount"))));
  const txnForms = (
    [
      ["DEPOSIT", "deposits", t("Deposits")],
      ["WITHDRAW", "withdrawals", t("Withdrawals")],
    ] as const
  ).filter(([, m]) => can(user, m, 2));

  return (
    <Shell kind={kind} t={t}>
      {kind === "txn" && txnForms.length === 0 && (
        <Card>
          <Empty title={t("Your role may not enter deposits or withdrawals")}>{t("Ask an administrator (Staff & roles).")}</Empty>
        </Card>
      )}
      {kind === "txn" &&
        txnForms.map(([type, , title]) => (
          <BatchEntry
            key={type}
            kind="txn"
            title={title}
            fixed={{ type }}
            cols={txnCols(type)}
            carryBrand={settings.entry.carryBrand}
            enterSaves={settings.entry.enterSaves}
            brands={brands}
            brandId={brandId}
            save={saveBatch}
            loadLists={loadLists}
            note={notes.txn}
            totals={[{ col: "amount", label: title }]}
          />
        ))}
      {kind !== "txn" && (
        <BatchEntry
          key={kind}
          kind={kind}
          cols={shown(cols[kind])}
          carryBrand={settings.entry.carryBrand}
            enterSaves={settings.entry.enterSaves}
          brands={brands}
          brandId={brandId}
          save={saveBatch}
          loadLists={loadLists}
          note={notes[kind]}
          totals={kind === "claim" ? [{ col: "amount", label: t("Bonus") }] : kind === "box" ? [{ col: "amount", label: t("Lucky Box") }] : []}
        />
      )}
      <Recent user={user} kind={kind} sp={sp} brandIds={scope.brandIds} channels={chOpts} brandCurrency={scope.brandCurrency} brandName={scope.brandName} />
    </Shell>
  );
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
}: {
  user: CurrentUser;
  kind: Kind;
  sp: Record<string, string | undefined>;
  brandIds: number[];
  channels: { value: string; label: string }[];
  brandCurrency: (id: number) => string;
  brandName: (id: number) => string;
}) {
  const [t, rights] = await Promise.all([getT(), editRights(user, "entry")]);
  const full = rights.full;
  const who = full && sp.who === "all" ? "all" : "me";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? "") ? sp.day! : todayStr();
  const created = { gte: dayStart(day), lt: dayStart(addDays(day, 1)) };
  const mine = who === "me" ? { createdById: user.id } : {};
  const canChange = rights.may;
  // Only worth a column when the list shows everyone's entries.
  const everyone = who === "all";
  const actions = (id: number, allowed: boolean, form: ReactNode, label: string) => (
    <EditCell kind={kind} id={id} label={label} allowed={allowed} t={t}>
      {form}
    </EditCell>
  );

  let table: ReactNode = null;
  let total = 0;

  if (kind === "txn") {
    const rows = await prisma.txn.findMany({
      where: { brandId: { in: brandIds }, createdAt: created, ...mine },
      include: { player: true, channel: true, createdBy: { select: { name: true } } },
      orderBy: { id: "desc" },
      take: 200,
    });
    total = rows.length;
    table = (
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("Brand")}</th>
            <th>{t("Player")}</th>
            <th>{t("Type")}</th>
            <th className="r">{t("Amount")}</th>
            <th>{t("Time")}</th>
            <th>{t("PG / bank")}</th>
            <th>{t("Withdrawal bank / account")}</th>
            <th>{t("Note")}</th>
            <th>{t("Ref")}</th>
            {everyone && <th>{t("Entered by")}</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((tx) => (
            <tr key={tx.id}>
              <td className="whitespace-nowrap text-ink-2">{brandName(tx.brandId)}</td>
              <td className="font-medium">
                <Link className="hover:underline" href={`/players/${tx.playerId}`}>
                  {tx.player.username}
                </Link>
              </td>
              <td>{tx.type === "DEPOSIT" ? <Chip tone="good">{t("Deposit")}</Chip> : <Chip tone="warning">{t("Withdrawal")}</Chip>}</td>
              <td className="r">{money(tx.amount, brandCurrency(tx.brandId))}</td>
              <td className="whitespace-nowrap text-ink-2">{dt(tx.txnAt)}</td>
              <td className="text-ink-2">{tx.channel?.name ?? "–"}</td>
              <td className="whitespace-nowrap text-ink-2">{payTo(tx)}</td>
              <td className="max-w-48 truncate text-ink-2">{tx.note ?? ""}</td>
              <td className="text-ink-2">{tx.ref ?? "–"}</td>
              {everyone && <td className="whitespace-nowrap text-ink-2">{tx.createdBy?.name ?? "–"}</td>}
              {actions(
                tx.id,
                canChange(tx.createdById, tx.createdAt) && can(user, txnModule(tx.type), 2),
                <TxnFields tx={tx} channels={channels} t={t} />,
                t("transaction"),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (kind === "claim") {
    const rows = await prisma.promoClaim.findMany({
      where: { promotion: { brandId: { in: brandIds } }, createdAt: created, ...mine },
      include: { player: true, promotion: true, createdBy: { select: { name: true } } },
      orderBy: { id: "desc" },
      take: 200,
    });
    total = rows.length;
    table = (
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("Brand")}</th>
            <th>{t("Player")}</th>
            <th>{t("Promotion")}</th>
            <th className="r">{t("Bonus")}</th>
            <th>{t("Time")}</th>
            {everyone && <th>{t("Entered by")}</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="whitespace-nowrap text-ink-2">{brandName(c.promotion.brandId)}</td>
              <td className="font-medium">{c.player.username}</td>
              <td>{c.promotion.name}</td>
              <td className="r">{money(c.amount, brandCurrency(c.promotion.brandId))}</td>
              <td className="whitespace-nowrap text-ink-2">{dt(c.claimedAt)}</td>
              {everyone && <td className="whitespace-nowrap text-ink-2">{c.createdBy?.name ?? "–"}</td>}
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
  } else if (kind === "box") {
    const rows = await prisma.boxEntry.findMany({
      where: { brandId: { in: brandIds }, kind: "IN", createdAt: created, ...mine },
      include: { player: true, promotion: true, createdBy: { select: { name: true } } },
      orderBy: { id: "desc" },
      take: 200,
    });
    total = rows.length;
    table = (
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("Brand")}</th>
            <th>{t("Player")}</th>
            <th>{t("Promotion")}</th>
            <th className="r">{t("Points into the box")}</th>
            <th>{t("Time")}</th>
            <th>{t("Note")}</th>
            {everyone && <th>{t("Entered by")}</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td className="whitespace-nowrap text-ink-2">{brandName(b.brandId)}</td>
              <td className="font-medium">
                <Link className="hover:underline" href={`/players/${b.playerId}`}>
                  {b.player.username}
                </Link>
              </td>
              <td>{b.promotion.name}</td>
              <td className="r">{money(b.amount, brandCurrency(b.brandId))}</td>
              <td className="whitespace-nowrap text-ink-2">{dt(b.at)}</td>
              <td className="max-w-48 truncate text-ink-2">{b.note ?? ""}</td>
              {everyone && <td className="whitespace-nowrap text-ink-2">{b.createdBy?.name ?? "–"}</td>}
              {actions(
                b.id,
                canChange(b.createdById, b.createdAt),
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Points into the box")}>
                    <input name="amount" className="input" defaultValue={n(b.amount)} inputMode="decimal" />
                  </Field>
                  <Field label={t("Date & time")}>
                    <input name="time" type="datetime-local" className="input" defaultValue={toLocalInput(b.at)} />
                  </Field>
                  <Field label={t("Note")} className="col-span-2">
                    <input name="note" className="input" defaultValue={b.note ?? ""} />
                  </Field>
                </div>,
                t("Lucky Box entry"),
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
            <th>{t("Brand")}</th>
            <th>{t("Username")}</th>
            <th>{t("Phone")}</th>
            <th>{t("Name")}</th>
            <th>{t("Note")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="whitespace-nowrap text-ink-2">{brandName(p.brandId)}</td>
              <td className="font-medium">
                <Link className="hover:underline" href={`/players/${p.id}`}>
                  {p.username}
                </Link>
              </td>
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
      note={`${total}${total === 200 ? "+" : ""} · ${who === "me" ? t("by you") : t("by everyone")}${rights.note ? " · " + rights.note : ""}`}
      action={
        <form action="/entry" className="flex items-center gap-2">
          <BrandFilter />
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
