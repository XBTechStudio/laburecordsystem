import "server-only";

import { cache } from "react";
import { prisma } from "@/lib/db";

/** Every brand's name and colour, read once per request. */
const brands = cache(async () => new Map((await prisma.brand.findMany({ select: { id: true, name: true, color: true } })).map((b) => [b.id, b])));

/** A brand's name in the colour picked for it under Brands (on a light tint of it, so it reads in dark mode too). */
export async function BrandTag({ id }: { id: number }) {
  const b = (await brands()).get(id);
  if (!b) return <span className="text-muted">#{id}</span>;
  if (!b.color) return <span className="font-medium">{b.name}</span>;
  return (
    <span
      className="inline-block rounded-md px-1.5 py-0.5 text-[0.95em] leading-tight font-semibold whitespace-nowrap"
      style={{ color: b.color, backgroundColor: `color-mix(in srgb, ${b.color} 14%, transparent)` }}
    >
      {b.name}
    </span>
  );
}
