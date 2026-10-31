import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, ActionForm, Submit } from "@/components/client";
import { Card, Chip, Field, Notice, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { toLocalInput } from "@/lib/dates";
import { ago, count, dt } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import type { ChannelMap, SyncResult } from "@/lib/platform-sync";
import { masked, open } from "@/lib/secret-box";
import { deletePlatform, saveChannelMap, savePlatform, setPlatformEnabled, syncPlatformNow } from "./actions";

const ZONES = ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth", "Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Jakarta", "Asia/Bangkok", "UTC"];

/** A brand's connection to its platform's API: the key, what to read, and how the last runs went. */
export default async function PlatformPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePage("brands", 3);
  const brandId = Number((await params).id);
  const [t, brand, link, channels] = await Promise.all([
    getT(),
    prisma.brand.findUnique({ where: { id: brandId } }),
    prisma.platformLink.findUnique({ where: { brandId } }),
    prisma.payChannel.findMany({ where: { active: true }, orderBy: [{ type: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
  ]);
  if (!brand || !can(user, "brands", 3)) notFound();
  const [synced, linked] = link
    ? await Promise.all([
        prisma.txn.count({ where: { brandId, ref: { not: null }, importId: null, createdById: null } }),
        prisma.player.count({ where: { brandId, extId: { not: null } } }),
      ])
    : [0, 0];
  const last = link?.lastResult as (SyncResult & { at: string }) | null;
  const map = Object.entries((link?.channelMap as ChannelMap | null) ?? {});
  let token = "";
  try {
    token = link ? masked(open(link.tokenEnc)) : "";
  } catch {
    token = t("(can't be read — enter it again)");
  }
  const status = !link ? null : !link.enabled ? (
    <Chip>{t("Paused")}</Chip>
  ) : link.lastError ? (
    <Chip tone="critical">{t("Error")}</Chip>
  ) : (
    <Chip tone="good">{t("Running")}</Chip>
  );

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={t("Platform API: {name}", { name: brand.name })}
        desc={t("Reads this brand's deposits, withdrawals, bonus claims, players and daily bets straight from its platform, every 2 minutes.")}
        actions={
          <Link href="/admin/brands" className="btn">
            {t("Back to brands")}
          </Link>
        }
      />

      {link && (
        <Card
          title={t("Status")}
          note={status}
        >
          <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted">{t("Last run")}: </span>
              {link.lastRunAt ? `${dt(link.lastRunAt)} (${ago(link.lastRunAt, t)})` : t("Not yet")}
            </div>
            <div>
              <span className="text-muted">{t("Last success")}: </span>
              {link.lastOkAt ? dt(link.lastOkAt) : t("Not yet")}
            </div>
            <div>
              <span className="text-muted">{t("Transactions read up to")}: </span>
              {link.txnCursor ? dt(link.txnCursor) : t("Not yet")}
            </div>
            <div>
              <span className="text-muted">{t("Daily bets complete up to")}: </span>
              {link.betDay ?? t("Not yet")}
            </div>
            <div>
              <span className="text-muted">{t("Transactions from the platform")}: </span>
              {count(synced)}
            </div>
            <div>
              <span className="text-muted">{t("Players linked to the platform")}: </span>
              {count(linked)}
            </div>
            {last && (
              <div className="sm:col-span-2">
                <span className="text-muted">{t("Last run added")}: </span>
                {t("{txns} transactions, {claims} bonus claims, {players} new players", { txns: last.txns, claims: last.claims, players: last.players })}
                {last.more ? ` · ${t("more to read")}` : ""}
              </div>
            )}
          </div>
          {link.lastError && <div className="mt-3 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical-ink">{link.lastError}</div>}
          <div className="mt-4 flex flex-wrap gap-2">
            {link.enabled ? (
              <ActionButton action={setPlatformEnabled} fields={{ brandId, on: 0 }} className="btn">
                {t("Pause sync")}
              </ActionButton>
            ) : (
              <ActionButton action={setPlatformEnabled} fields={{ brandId, on: 1 }} className="btn btn-primary">
                {t("Start sync")}
              </ActionButton>
            )}
            <ActionForm action={syncPlatformNow} className="inline">
              <input type="hidden" name="brandId" value={brandId} />
              <Submit className="btn" pending={t("Reading…")}>
                {t("Sync now")}
              </Submit>
            </ActionForm>
            <ActionButton
              action={deletePlatform}
              fields={{ brandId }}
              question={t("Remove this connection? The key is deleted and nothing more is read. Data already read stays.")}
              className="btn text-critical-ink"
            >
              {t("Remove connection")}
            </ActionButton>
          </div>
        </Card>
      )}

      <Card title={link ? t("Connection") : t("Connect the platform")}>
        {!link && (
          <div className="mb-4">
            <Notice>
              {t("On the platform's Manage API page: create an Access ID and token, and add our server IP {ip} to the IP whitelist. Then fill them in below.", { ip: process.env.SERVER_IP || "?" })}
            </Notice>
          </div>
        )}
        <ActionForm action={savePlatform} className="space-y-3">
          <input type="hidden" name="brandId" value={brandId} />
          <Field label={t("API address")} hint={t("e.g. https://top1au.net/api/v1/index.php")}>
            <input name="apiUrl" className="input" defaultValue={link?.apiUrl ?? ""} required placeholder="https://…/api/v1/index.php" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("Merchant ID")}>
              <input name="merchantId" className="input" defaultValue={link?.merchantId ?? ""} required />
            </Field>
            <Field label={t("Access ID")}>
              <input name="accessId" className="input" defaultValue={link?.accessId ?? ""} required />
            </Field>
            <Field label={t("Token")} hint={link ? t("Saved: {t}. Leave empty to keep it.", { t: token }) : undefined}>
              <input name="token" className="input" type="password" autoComplete="off" required={!link} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Read from")} hint={t("Nothing earlier is read. Pick the moment staff stopped entering this brand by hand, so nothing is counted twice.")}>
              <input name="startAt" type="datetime-local" className="input" defaultValue={toLocalInput(link?.startAt ?? new Date())} required />
            </Field>
            <Field label={t("Platform time zone")} hint={t("The platform's own clock; its daily bets are per day in this zone.")}>
              <input name="timeZone" className="input" list="zones" defaultValue={link?.timeZone ?? "Australia/Sydney"} required />
              <datalist id="zones">
                {ZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
          </div>
          <fieldset>
            <legend className="label">{t("What to read")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["syncTxns", t("Deposits and withdrawals"), link?.syncTxns ?? true],
                  ["syncClaims", t("Bonus claims (promotions)"), link?.syncClaims ?? true],
                  ["syncPlayers", t("New players and their details"), link?.syncPlayers ?? true],
                  ["syncBets", t("Daily bets and game win/loss"), link?.syncBets ?? true],
                ] as const
              ).map(([name, label, on]) => (
                <label key={name} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={name} defaultChecked={on} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end">
            <Submit pending={t("Saving and testing…")}>{t("Save and test")}</Submit>
          </div>
        </ActionForm>
        {link && !link.enabled && <p className="mt-2 text-xs text-muted">{t("Saved connections start paused. Press Start sync above once the test passes.")}</p>}
      </Card>

      {link && map.length > 0 && (
        <Card flush title={t("Platform accounts → our PG / bank")} note={t("New ones are added automatically as \"{brand} · …\"; point them at your own accounts here.", { brand: brand.name })}>
          <ActionForm action={saveChannelMap}>
            <input type="hidden" name="brandId" value={brandId} />
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("On the platform")}</th>
                    <th>{t("Counts as")}</th>
                  </tr>
                </thead>
                <tbody>
                  {map.map(([key, v]) => (
                    <tr key={key}>
                      <td>
                        {v.label}
                        <div className="text-xs text-muted">{key.startsWith("bank:") ? t("Platform bank account") : t("Payment method")}</div>
                      </td>
                      <td>
                        <select name={`ch:${key}`} className="input" defaultValue={v.id}>
                          {channels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <div className="flex justify-end p-4">
              <Submit>{t("Save")}</Submit>
            </div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
