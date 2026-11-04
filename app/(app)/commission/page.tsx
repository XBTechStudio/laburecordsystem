import { PayoutReport } from "@/components/payout-report";

export default function CommissionPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return <PayoutReport kind="commission" searchParams={searchParams} />;
}
