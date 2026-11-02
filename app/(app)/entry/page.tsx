import { redirect } from "next/navigation";
import { requirePage } from "@/lib/auth";
import { EntryView } from "./view";

export default async function EntryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  // Old links from when the forms were tabs of one page.
  if (sp.kind === "box") redirect("/lucky-box/add");
  if (sp.kind === "player") redirect("/players/add");
  return <EntryView user={await requirePage("entry", 2)} kind="txn" sp={sp} />;
}
