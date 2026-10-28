// Shared by server pages and the live preview in Settings.

export type TierRule = { name: string; minScore: number };

export type TierScoring = {
  amountFull: number;
  countFull: number;
  avgFull: number;
  weightAmount: number;
  weightCount: number;
  weightAvg: number;
  tiers: TierRule[];
  lowestName: string;
};

export type Tier = { score: number; tier: string; rank: number };

/** rank 0 = best tier. */
export function scorePlayer(s: TierScoring, total: number, cnt: number): Tier {
  const avg = cnt ? total / cnt : 0;
  const part = (v: number, full: number) => (full > 0 ? Math.min(v / full, 1) : 0);
  const wSum = s.weightAmount + s.weightCount + s.weightAvg || 1;
  const score =
    ((part(total, s.amountFull) * s.weightAmount + part(cnt, s.countFull) * s.weightCount + part(avg, s.avgFull) * s.weightAvg) / wSum) *
    100;
  const sorted = [...s.tiers].sort((a, b) => b.minScore - a.minScore);
  const i = sorted.findIndex((t) => score >= t.minScore);
  return { score: Math.round(score), tier: i >= 0 ? sorted[i].name : s.lowestName, rank: i >= 0 ? i : sorted.length };
}
