import Link from "next/link";
import { ActionButton, ActionForm, Dialog, Submit } from "@/components/client";
import { Card, Chip, Empty, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { count, dt } from "@/lib/format";
import { tk } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { getScope } from "@/lib/scope";
import { deleteTemplate, renameTemplate, undoImport } from "./actions";
import { ImportWizard } from "./wizard";

const KIND: Record<string, string> = { txn: tk("Deposits / withdrawals"), player: tk("Players"), claim: tk("Promotion claims"), flow: tk("PG / bank statement") };

export default async function ImportPage() {
  const user = await requirePage("import", 2);
  const [scope, t] = await Promise.all([getScope(user), getT()]);
  const full = can(user, "import", 3);
  const [batches, templates] = await Promise.all([
    prisma.importBatch.findMany({ where: { brandId: { in: scope.brandIds } }, orderBy: { id: "desc" }, take: 30 }),
    prisma.importTemplate.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] }),
  ]);

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title={t("Excel import")}
        desc={t("Upload an export from any platform. The system matches the columns, shows you a preview, and skips rows that are already in.")}
        actions={
          <Link href="/entry" className="btn">
            ← {t("Data entry")}
          </Link>
        }
      />
      <ImportWizard brands={scope.brands.map((b) => ({ id: b.id, name: b.name }))} initialBrand={scope.current?.id ?? (scope.brands.length === 1 ? scope.brands[0].id : null)} />

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <Card flush title={t("Recent imports")} note={full ? t("Undo removes everything an import added") : undefined}>
          {batches.length === 0 ? (
            <Empty title={t("No imports yet")} />
          ) : (
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("When")}</th>
                    <th>{t("File")}</th>
                    <th>{t("Brand")}</th>
                    <th className="r">{t("Added")}</th>
                    <th className="r">{t("Skipped")}</th>
                    <th>{t("By")}</th>
                    {full && <th />}
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className={b.undoneAt ? "opacity-60" : ""}>
                      <td className="whitespace-nowrap text-ink-2">{dt(b.createdAt)}</td>
                      <td>
                        <div className="max-w-56 truncate font-medium" title={b.filename}>
                          {b.filename}
                        </div>
                        <div className="text-xs text-muted">{t(KIND[b.kind] ?? b.kind)}</div>
                      </td>
                      <td>{scope.brandName(b.brandId)}</td>
                      <td className="r">{count(b.inserted)}</td>
                      <td className="r">{count(b.skipped)}</td>
                      <td className="text-ink-2">{b.userName}</td>
                      {full && (
                        <td className="r">
                          {b.undoneAt ? (
                            <Chip>{t("Undone")}</Chip>
                          ) : (
                            <ActionButton action={undoImport} fields={{ id: b.id }} question={t("Undo the import of {file}? Everything it added will be removed.", { file: b.filename })}>
                              {t("Undo")}
                            </ActionButton>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title={t("Saved templates")} note={t("Picked automatically when a file has the same columns")}>
          {templates.length === 0 ? (
            <p className="text-sm text-ink-2">{t("None yet. After matching a file's columns, give the matching a name to save it.")}</p>
          ) : (
            <ul className="divide-y divide-[var(--line)] text-sm">
              {templates.map((tpl) => (
                <li key={tpl.id} className="flex items-center gap-2 py-2 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{tpl.name}</div>
                    <div className="text-xs text-muted">{t(KIND[tpl.kind] ?? tpl.kind)}</div>
                  </div>
                  {full && (
                    <>
                      <Dialog label={t("Rename")} title={t("Rename template")}>
                        <ActionForm action={renameTemplate} close className="space-y-3">
                          <input type="hidden" name="id" value={tpl.id} />
                          <input name="name" className="input" defaultValue={tpl.name} required />
                          <div className="flex justify-end">
                            <Submit>{t("Save")}</Submit>
                          </div>
                        </ActionForm>
                      </Dialog>
                      <ActionButton action={deleteTemplate} fields={{ id: tpl.id }} question={t("Delete template “{name}”?", { name: tpl.name })}>
                        {t("Delete")}
                      </ActionButton>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
