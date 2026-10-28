import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import type { Brand } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { n } from "@/lib/format";

export const BRAND_COOKIE = "xb_brand";

export type Scope = {
  brands: Brand[];
  /** The brand picked in the top bar, or null for "All brands". */
  current: Brand | null;
  brandIds: number[];
  /** Currency the page shows totals in: the brand's own, or the base currency when several brands are combined. */
  currency: string;
  /** Multiply a brand's amount by this to get the page currency. */
  rate: (brandId: number) => number;
  brandName: (brandId: number) => string;
  brandCurrency: (brandId: number) => string;
};

export const getScope = cache(async (user: CurrentUser): Promise<Scope> => {
  const [brands, settings, picked] = await Promise.all([
    prisma.brand.findMany({
      where: { active: true, ...(user.brandIds ? { id: { in: user.brandIds } } : {}) },
      orderBy: { name: "asc" },
    }),
    getSettings(),
    cookies().then((c) => c.get(BRAND_COOKIE)?.value),
  ]);
  const current = brands.length === 1 ? brands[0] : (brands.find((b) => String(b.id) === picked) ?? null);
  const byId = new Map(brands.map((b) => [b.id, b]));
  return {
    brands,
    current,
    brandIds: current ? [current.id] : brands.map((b) => b.id),
    currency: current ? current.currency : settings.baseCurrency,
    rate: (id) => (current ? 1 : n(byId.get(id)?.fxRate ?? 1)),
    brandName: (id) => byId.get(id)?.name ?? `#${id}`,
    brandCurrency: (id) => byId.get(id)?.currency ?? settings.baseCurrency,
  };
});
