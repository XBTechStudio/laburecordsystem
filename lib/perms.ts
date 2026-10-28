// Permission model shared by server and client code (no server imports here).

import { tk } from "@/lib/i18n";

export const LEVELS = [
  { value: 0, label: tk("No access") },
  { value: 1, label: tk("View") },
  { value: 2, label: tk("View + add") },
  { value: 3, label: tk("Full") },
] as const;

export type Level = 0 | 1 | 2 | 3;

/** `levels` = the choices that make sense for the module. "Full" adds edit, delete and configuration. */
export const MODULES = [
  { key: "dashboard", href: "/", label: tk("Dashboard"), levels: [0, 1], hint: tk("Overview numbers and alerts") },
  { key: "entry", href: "/entry", label: tk("Data entry"), levels: [0, 2, 3], hint: tk("Add = enter data and see own entries · Full = edit/delete anyone's") },
  { key: "import", href: "/import", label: tk("Excel import"), levels: [0, 2, 3], hint: tk("Full = undo imports and manage templates") },
  { key: "reports", href: "/reports", label: tk("Reports"), levels: [0, 1, 3], hint: tk("Full = save reports for the whole team") },
  { key: "players", href: "/players", label: tk("Players"), levels: [0, 1, 3], hint: tk("Full = edit player details and assign CS") },
  { key: "churn", href: "/churn", label: tk("Churn follow-up"), levels: [0, 1, 2, 3], hint: tk("Add = log contacts · Full = assign players to others") },
  { key: "promotions", href: "/promotions", label: tk("Promotions"), levels: [0, 1, 3], hint: tk("Full = create and edit promotions") },
  { key: "cs", href: "/cs", label: tk("CS recall tracking"), levels: [0, 1, 2, 3], hint: tk("Add = log own contacts · Full = edit/delete any log") },
  { key: "reconcile", href: "/reconcile", label: tk("PG / bank reconciliation"), levels: [0, 1, 2, 3], hint: tk("Add = enter real balances and transfers · Full = corrections, starting balances, deletions") },
  { key: "expenses", href: "/expenses", label: tk("Expenses & profit"), levels: [0, 1, 2, 3], hint: tk("Add = enter expenses · Full = edit/delete and manage categories") },
  { key: "dividends", href: "/dividends", label: tk("Shareholder dividends"), levels: [0, 1, 3], hint: tk("Full = shares, rules, settlements and payments") },
  { key: "brands", href: "/admin/brands", label: tk("Brands"), levels: [0, 1, 3], hint: "" },
  { key: "users", href: "/admin/users", label: tk("Staff & roles"), levels: [0, 1, 3], hint: "" },
  { key: "audit", href: "/admin/audit", label: tk("Audit log"), levels: [0, 1], hint: tk("Who added, changed or deleted what") },
  { key: "settings", href: "/admin/settings", label: tk("Settings"), levels: [0, 1, 3], hint: tk("Analysis rules, channels, categories") },
] as const;

export type Module = (typeof MODULES)[number]["key"];
export type Perms = Partial<Record<Module, Level>>;

export function levelOf(perms: Perms, m: Module): Level {
  return (perms[m] ?? 0) as Level;
}

const all = (l: Level) => Object.fromEntries(MODULES.map((m) => [m.key, Math.min(l, Math.max(...m.levels)) as Level])) as Perms;

export const DEFAULT_ROLES: { name: string; locked?: boolean; perms: Perms }[] = [
  { name: "Administrator", locked: true, perms: all(3) },
  {
    name: "Management",
    perms: { ...all(3), brands: 1, users: 1, settings: 1 },
  },
  {
    name: "Supervisor",
    perms: {
      dashboard: 1,
      entry: 3,
      import: 3,
      reports: 3,
      players: 3,
      churn: 3,
      promotions: 3,
      cs: 3,
      reconcile: 3,
      expenses: 2,
      audit: 1,
    },
  },
  { name: "Data entry", perms: { entry: 2, import: 2, players: 1 } },
  { name: "Customer service", perms: { players: 1, churn: 2, cs: 2 } },
];
