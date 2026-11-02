import { requirePage } from "@/lib/auth";
import { EntryView } from "../../entry/view";

export default async function LuckyBoxAddPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return <EntryView user={await requirePage("entry", 2)} kind="box" sp={await searchParams} />;
}
