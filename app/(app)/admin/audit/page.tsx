import { AutoSelect } from "@/components/client";
import { RangeBar } from "@/components/range";
import { Card, Chip, Empty, PageHeader, Pager, TableWrap } from "@/components/ui";
import { requirePage } from "@/lib/auth";
import { instantRange, parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { dt } from "@/lib/format";
import { tk } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { getScope } from "@/lib/scope";

const ACTIONS: Record<string, { label: string; tone: "good" | "brand" | "critical" | "warning" | "neutral" }> = {
  CREATE: { label: tk("Added"), tone: "good" },
  IMPORT: { label: tk("Imported"), tone: "good" },
  UPDATE: { label: tk("Changed"), tone: "brand" },
  SETTLE: { label: tk("Settled"), tone: "brand" },
  PAY: { label: tk("Paid"), tone: "brand" },
  DELETE: { label: tk("Deleted"), tone: "critical" },
  UNDO: { label: tk("Undone"), tone: "warning" },
  LOGIN: { label: tk("Signed in"), tone: "neutral" },
};

const ENTITIES: Record<string, string> = {
  Txn: tk("Deposits & withdrawals"),
  ChannelMove: tk("Transfers and other movements"),
  BalanceCheck: tk("Balance checks"),
  PromoClaim: tk("Promotion claims"),
  Player: tk("Players"),
  Expense: tk("Expenses"),
  ExpenseCategory: tk("Categories"),
  Promotion: tk("Promotions"),
  ContactLog: tk("CS contacts"),
  ImportBatch: tk("Excel import"),
  ImportTemplate: tk("Import templates"),
  Brand: tk("Brands"),
  User: tk("Staff"),
  Role: tk("Roles"),
  Setting: tk("Settings"),
  PayChannel: tk("PG & bank channels"),
  Shareholder: tk("Shareholders"),
  Holding: tk("Brand shares"),
  DividendRule: tk("Dividend rules"),
  Settlement: tk("Settlements"),
  SettlementLine: tk("Dividend payments"),
  DividendPayment: tk("Dividend payments"),
  SavedReport: tk("Saved reports"),
};

const PER_PAGE = 50;

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("audit");
  const sp = await searchParams;
  const range = parseRange(sp, "week");
  const [scope, t] = await Promise.all([getScope(user), getT()]);
  const page = Math.max(1, Number(sp.page) || 1);

  // People who can't see every brand only see changes in their brands (and none of the system-wide ones).
  const where = {
    createdAt: instantRange(range),
    ...(sp.user ? { userId: Number(sp.user) } : {}),
    ...(sp.action ? { action: sp.action } : {}),
    ...(sp.entity ? { entity: sp.entity } : {}),
    ...(user.brandIds ? { brandId: { in: user.brandIds } } : {}),
  };
  const [rows, total, users, entities] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { id: "desc" }, take: PER_PAGE, skip: (page - 1) * PER_PAGE }),
    prisma.auditLog.count({ where }),
    prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.auditLog.groupBy({ by: ["entity"], orderBy: { entity: "asc" } }),
  ]);
  const qs = (p: number) => `/admin/audit?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(sp).filter(([, v]) => v)) as Record<string, string>), page: String(p) })}`;

  return (
    <div className="max-w-6xl">
      <PageHeader title={t("Audit log")} desc={t("Every addition, change and deletion, with who did it and when.")} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RangeBar path="/admin/audit" range={range} params={sp} />
        <form action="/admin/audit" className="flex flex-wrap gap-2">
          {range.preset ? (
            <input type="hidden" name="preset" value={range.preset} />
          ) : (
            <>
              <input type="hidden" name="from" value={range.from} />
              <input type="hidden" name="to" value={range.to} />
            </>
          )}
          <AutoSelect name="user" defaultValue={sp.user ?? ""} className="input h-8 w-auto">
            <option value="">{t("Everyone")}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </AutoSelect>
          <AutoSelect name="action" defaultValue={sp.action ?? ""} className="input h-8 w-auto">
            <option value="">{t("All actions")}</option>
            {Object.entries(ACTIONS).map(([k, a]) => (
              <option key={k} value={k}>
                {t(a.label)}
              </option>
            ))}
          </AutoSelect>
          <AutoSelect name="entity" defaultValue={sp.entity ?? ""} className="input h-8 w-auto">
            <option value="">{t("All records")}</option>
            {entities.map((e) => (
              <option key={e.entity} value={e.entity}>
                {t(ENTITIES[e.entity] ?? e.entity)}
              </option>
            ))}
          </AutoSelect>
        </form>
      </div>
      <Card flush>
        {rows.length === 0 ? (
          <Empty title={t("Nothing in this period")} />
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("When")}</th>
                  <th>{t("Who")}</th>
                  <th>{t("Action")}</th>
                  <th>{t("What")}</th>
                  <th>{t("Brand")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const a = ACTIONS[r.action] ?? { label: r.action, tone: "neutral" as const };
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap text-ink-2">{dt(r.createdAt)}</td>
                      <td className="whitespace-nowrap">{r.userName ?? t("System")}</td>
                      <td>
                        <Chip tone={a.tone}>{t(a.label)}</Chip>
                      </td>
                      <td className="min-w-72">
                        <div className="text-xs text-muted">{t(ENTITIES[r.entity] ?? r.entity)}</div>
                        <div>{r.summary ?? `#${r.entityId}`}</div>
                        {r.detail != null && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-brand-ink">{t("Details")}</summary>
                            <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 text-xs">{JSON.stringify(r.detail, null, 2)}</pre>
                          </details>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-ink-2">{r.brandId ? scope.brandName(r.brandId) : "–"}</td>
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
