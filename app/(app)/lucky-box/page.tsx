import Link from "next/link";
import { ActionForm, AutoSelect, Dialog, Submit } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Chip, Empty, Field, Info, PageHeader, TableWrap } from "@/components/ui";
import { BoxRuleForm } from "../promotions/box-form";
import { EditCell } from "../entry/edit-cell";
import { autoRelease, boxText, type BoxRule } from "@/lib/box-rule";
import { can, requirePage } from "@/lib/auth";
import { dayStart, addDays, parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { editRights } from "@/lib/edit-rights";
import { count, dt, money, money0, n } from "@/lib/format";
import { tk, type T } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { boxPromos, boxStates, type BoxState } from "@/lib/lucky-box";
import { alertTick } from "@/lib/promo-engine";
import { getScope } from "@/lib/scope";
import { releaseFromBox } from "./actions";

const MAX_ROWS = 300;
const STATUS = [
  { value: "open", label: tk("Boxes with points") },
  { value: "ready", label: tk("Ready to release") },
  { value: "all", label: tk("All boxes") },
];
const KIND: Record<string, [string, "good" | "warning" | "neutral"]> = {
  IN: [tk("Into the box"), "neutral"],
  RELEASE: [tk("Released"), "good"],
  EXPIRE: [tk("Ran out"), "warning"],
};

/** What the player still needs to do before the box opens. */
function waiting(s: BoxState, r: BoxRule, t: T, cur: string) {
  if (!autoRelease(r)) return t("Released by hand");
  const parts: string[] = [];
  if (r.minNetWin > 0) parts.push(t("net win {a} of {b} needed", { a: money0(Math.max(0, s.bestNetWin), cur), b: money0(r.minNetWin, cur) }));
  if (r.minDeposit > 0) parts.push(t("deposits {a} of {b}", { a: money0(s.deposit, cur), b: money0(r.minDeposit, cur) }));
  return parts.join(" · ");
}

export default async function LuckyBoxPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("luckybox");
  const sp = await searchParams;
  await alertTick();
  const [scope, t, rights] = await Promise.all([getScope(user), getT(), editRights(user, "entry")]);
  const range = parseRange(sp, "month");
  const act = can(user, "luckybox", 2);
  const full = can(user, "luckybox", 3);
  const manage = can(user, "promotions", 3);
  const status = STATUS.find((s) => s.value === sp.status)?.value ?? "open";
  const q = (sp.q ?? "").trim().toLowerCase();

  const allPromos = await boxPromos(scope.brandIds, false);
  const promoId = Number(sp.promo) || 0;
  const promos = promoId ? allPromos.filter((p) => p.id === promoId) : allPromos;
  const promoById = new Map(allPromos.map((p) => [p.id, p]));

  const states = await boxStates({ promos });
  const players = new Map(
    (await prisma.player.findMany({ where: { id: { in: [...new Set(states.map((s) => s.playerId))] } }, select: { id: true, username: true, name: true } })).map((p) => [p.id, p]),
  );
  const shown = states
    .filter((s) => (status === "ready" ? !!s.ready : status === "open" ? s.balance > 0.005 : true))
    .filter((s) => !q || players.get(s.playerId)?.username.toLowerCase().includes(q))
    .sort((a, b) => Number(!!b.ready) - Number(!!a.ready) || b.balance - a.balance || b.lastAt.getTime() - a.lastAt.getTime());
  const rows = shown.slice(0, MAX_ROWS);

  // Money that went in and out in the selected dates.
  const flows = promos.length
    ? await prisma.boxEntry.groupBy({
        by: ["kind", "brandId"],
        where: { promotionId: { in: promos.map((p) => p.id) }, at: { gte: dayStart(range.from), lt: dayStart(addDays(range.to, 1)) } },
        _sum: { amount: true },
      })
    : [];
  const flow = (k: string) => flows.filter((f) => f.kind === k).reduce((a, f) => a + n(f._sum.amount) * scope.rate(f.brandId), 0);
  const inBoxes = states.reduce((a, s) => a + Math.max(0, s.balance) * scope.rate(s.brandId), 0);
  const ready = states.filter((s) => s.ready);
  const readySum = ready.reduce((a, s) => a + s.ready!.amount * scope.rate(s.brandId), 0);

  const history = rows.length
    ? await prisma.boxEntry.findMany({
        where: { OR: rows.map((s) => ({ playerId: s.playerId, promotionId: s.promotionId })) },
        include: { createdBy: { select: { name: true } } },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take: 3000,
      })
    : [];
  const multi = !scope.current;
  const params = Object.fromEntries(Object.entries(sp).filter(([, v]) => v)) as Record<string, string>;

  return (
    <div className="max-w-7xl">
      <PageHeader
        title={t("Lucky Box")}
        desc={
          <>
            {t("Winnings players can't withdraw yet, and when they can have them back.")}{" "}
            <Info>
              {t("Staff put the points into the box under Data entry → Lucky Box (after taking them off the player on the platform). The system checks every deposit and withdrawal against the promotion's release rule and tells CS how much to give back. After adding the points on the platform, press Release here or on the alert. A release is also recorded as a claim of the promotion, so it counts as promotion cost.")}
            </Info>
          </>
        }
        actions={
          <Link href="/entry?kind=box" className="btn btn-primary">
            + {t("Put into a box")}
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RangeBar path="/lucky-box" range={range} params={sp} />
        <form action="/lucky-box" className="flex flex-wrap gap-2">
          {Object.entries(params)
            .filter(([k]) => !["promo", "status", "q"].includes(k))
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <AutoSelect name="promo" defaultValue={promoId || ""} className="input h-8 w-auto">
            <option value="">{t("All Lucky Box promotions")}</option>
            {allPromos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {multi ? ` · ${scope.brandName(p.brandId)}` : ""}
              </option>
            ))}
          </AutoSelect>
          <AutoSelect name="status" defaultValue={status} className="input h-8 w-auto">
            {STATUS.map((s) => (
              <option key={s.value} value={s.value}>
                {t(s.label)}
              </option>
            ))}
          </AutoSelect>
          <input name="q" defaultValue={sp.q ?? ""} placeholder={t("Player username")} className="input h-8 w-40" />
        </form>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          [t("In boxes now"), money0(inBoxes, scope.currency), ""],
          [t("Ready to release"), money0(readySum, scope.currency), t("{n} players", { n: ready.length })],
          [t("Put in"), money0(flow("IN"), scope.currency), t("selected dates")],
          [t("Released"), money0(flow("RELEASE"), scope.currency), t("selected dates")],
          [t("Ran out"), money0(flow("EXPIRE"), scope.currency), t("selected dates")],
        ].map(([l, v, sub]) => (
          <div key={l} className="card p-3.5">
            <div className="text-xs text-ink-2">{l}</div>
            <div className="mt-1 text-lg font-semibold">{v}</div>
            {sub && <div className="text-xs text-muted">{sub}</div>}
          </div>
        ))}
      </div>

      {allPromos.length === 0 ? (
        <Card>
          <Empty title={t("No Lucky Box promotions yet")}>
            {t("Turn one on under Promotions → Lucky Box, or type a new promotion name under Data entry → Lucky Box.")}
          </Empty>
        </Card>
      ) : (
        <>
          <Card flush className="mb-5" title={t("Release rules")}>
            <TableWrap>
              <table className="tbl">
                <tbody>
                  {allPromos.map((p) => {
                    const cur = scope.brandCurrency(p.brandId);
                    return (
                      <tr key={p.id} className={p.active ? "" : "opacity-60"}>
                        <td className="font-medium">
                          {p.name}
                          {!p.active && <span className="ml-1 text-xs text-muted">{t("Ended")}</span>}
                        </td>
                        {multi && <td className="text-ink-2">{scope.brandName(p.brandId)}</td>}
                        <td className="text-ink-2">{boxText(p.rule, t, cur)}</td>
                        <td className="r">
                          {manage && (
                            <Dialog label={t("Edit")} title={t("Lucky Box: {name}", { name: p.name })}>
                              <BoxRuleForm id={p.id} rule={p.rule} currency={cur} t={t} />
                            </Dialog>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          <Card flush title={t("Players' boxes")} note={shown.length > MAX_ROWS ? t("First {n} of {total}", { n: MAX_ROWS, total: shown.length }) : count(shown.length)}>
            {rows.length === 0 ? (
              <Empty title={status === "ready" ? t("No box can be released right now") : t("No boxes here")} />
            ) : (
              <TableWrap>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{t("Player")}</th>
                      {multi && <th>{t("Brand")}</th>}
                      <th>{t("Promotion")}</th>
                      <th className="r">{t("In the box")}</th>
                      <th>{t("Status")}</th>
                      <th className="r">{t("Put in")}</th>
                      <th className="r">{t("Released")}</th>
                      <th>{t("Last change")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => {
                      const p = promoById.get(s.promotionId)!;
                      const pl = players.get(s.playerId);
                      const cur = scope.brandCurrency(s.brandId);
                      const mine = history.filter((h) => h.playerId === s.playerId && h.promotionId === s.promotionId);
                      return (
                        <tr key={`${s.playerId}:${s.promotionId}`}>
                          <td>
                            <Link className="link font-medium" href={`/players/${s.playerId}`}>
                              {pl?.username}
                            </Link>
                            {pl?.name && <div className="text-xs text-muted">{pl.name}</div>}
                          </td>
                          {multi && <td className="text-ink-2">{scope.brandName(s.brandId)}</td>}
                          <td>{p.name}</td>
                          <td className="r font-medium">{money(s.balance, cur)}</td>
                          <td>
                            {s.balance <= 0.005 ? (
                              <Chip>{t("Empty")}</Chip>
                            ) : s.ready ? (
                              <>
                                <Chip tone="good">{t("Release {amount}", { amount: money(s.ready.amount, cur) })}</Chip>
                                <div className="mt-0.5 text-xs text-ink-2">
                                  {s.ready.netWin != null
                                    ? t("Withdrawal on {when} with a net win of {amount}", { when: dt(new Date(s.ready.at)), amount: money(s.ready.netWin, cur) })
                                    : t("Deposited {amount} since the box filled", { amount: money(s.ready.deposit, cur) })}
                                </div>
                              </>
                            ) : (
                              <span className="text-xs text-ink-2">{waiting(s, p.rule, t, cur)}</span>
                            )}
                          </td>
                          <td className="r text-ink-2">{money0(s.stored, cur)}</td>
                          <td className="r text-ink-2">{money0(s.released, cur)}</td>
                          <td className="whitespace-nowrap text-ink-2">{dt(s.lastAt)}</td>
                          <td className="r space-x-1 whitespace-nowrap">
                            {act && s.balance > 0.005 && (
                              <Dialog label={t("Release")} title={t("Release from {name}'s box", { name: pl?.username ?? "" })} className={`btn btn-sm ${s.ready ? "btn-primary" : ""}`}>
                                <ActionForm action={releaseFromBox} close className="space-y-3">
                                  <input type="hidden" name="playerId" value={s.playerId} />
                                  <input type="hidden" name="promotionId" value={s.promotionId} />
                                  <p className="text-sm text-ink-2">{t("Add the points to the player on the platform first, then record it here.")}</p>
                                  <Field label={t("Amount ({cur})", { cur })} hint={t("In the box: {amount}", { amount: money(s.balance, cur) })}>
                                    <input name="amount" className="input" inputMode="decimal" defaultValue={(s.ready?.amount ?? s.balance).toFixed(2)} required />
                                  </Field>
                                  <Field label={t("Note")}>
                                    <input name="note" className="input" />
                                  </Field>
                                  <div className="flex justify-end">
                                    <Submit>{t("Record release")}</Submit>
                                  </div>
                                </ActionForm>
                              </Dialog>
                            )}
                            <Dialog label={t("History")} title={t("Lucky Box history: {name}", { name: `${pl?.username} · ${p.name}` })} wide>
                              <table className="tbl">
                                <tbody>
                                  {mine.map((h) => (
                                    <tr key={h.id}>
                                      <td className="whitespace-nowrap text-ink-2">{dt(h.at)}</td>
                                      <td>
                                        <Chip tone={KIND[h.kind][1]}>{t(KIND[h.kind][0])}</Chip>
                                      </td>
                                      <td className="r">{(h.kind === "IN" ? "+ " : "− ") + money(h.amount, cur)}</td>
                                      <td className="text-ink-2">{h.note ?? ""}</td>
                                      <td className="text-ink-2">{h.createdBy?.name ?? (h.kind === "EXPIRE" ? t("System") : "–")}</td>
                                      <EditCell kind="box" id={h.id} label={t("Lucky Box entry")} brand={scope.brandName(s.brandId)} username={pl?.username ?? ""} allowed={full || rights.may(h.createdById, h.createdAt)} t={t}>
                                        <div className="grid grid-cols-2 gap-3">
                                          <Field label={t("Amount ({cur})", { cur })}>
                                            <input name="amount" className="input" defaultValue={n(h.amount)} inputMode="decimal" />
                                          </Field>
                                          <Field label={t("Note")}>
                                            <input name="note" className="input" defaultValue={h.note ?? ""} />
                                          </Field>
                                        </div>
                                      </EditCell>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </Dialog>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
