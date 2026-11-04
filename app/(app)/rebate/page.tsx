import { PayoutReport } from "@/components/payout-report";

export default function RebatePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return <PayoutReport kind="rebate" searchParams={searchParams} />;
}
