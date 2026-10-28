import { Chip } from "@/components/ui";
import { getT } from "@/lib/i18n-server";

const TONES = ["brand", "warning", "good", "neutral"] as const;

/** Tier names are data the client can rename; the default ones are translated. */
export async function TierChip({ name, rank, score }: { name: string; rank: number; score?: number }) {
  const t = await getT();
  return (
    <Chip tone={TONES[Math.min(rank, TONES.length - 1)]} title={score != null ? t("Score {score} / 100", { score }) : undefined}>
      {t(name)}
      {score != null && <span className="opacity-70">· {score}</span>}
    </Chip>
  );
}
