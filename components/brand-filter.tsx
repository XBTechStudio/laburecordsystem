import { setBrand } from "@/app/(app)/shell-actions";
import { requireUser } from "@/lib/auth";
import { getScope } from "@/lib/scope";
import { BrandSwitcher } from "./client";

/** The brand picker, placed first in a page's own filter row. The choice is remembered across pages. */
export async function BrandFilter() {
  const scope = await getScope(await requireUser());
  return <BrandSwitcher brands={scope.brands.map((b) => ({ id: b.id, name: b.name }))} current={scope.current?.id ?? null} action={setBrand} />;
}
