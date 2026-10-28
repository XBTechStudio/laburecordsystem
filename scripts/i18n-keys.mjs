// Lists every English text the UI translates, and which ones the dictionary is missing.
//   node scripts/i18n-keys.mjs           → prints missing keys
//   node scripts/i18n-keys.mjs --all     → prints all keys
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const dirs = ["app", "components", "lib"];
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|mjs)$/.test(e.name) && !p.includes(`${path.sep}i18n${path.sep}`)) files.push(p);
  }
};
for (const d of dirs) walk(path.join(root, d));

const STR = `"((?:[^"\\\\]|\\\\.)*)"`;
const patterns = [
  new RegExp(`\\bt\\(\\s*${STR}`, "g"),
  new RegExp(`\\btk\\(\\s*${STR}`, "g"),
  // messages that run() / batch saving translate
  new RegExp(`\\bneed\\([^;]*?,\\s*${STR}\\s*\\)`, "g"),
  new RegExp(`new (?:UserError|Denied)\\(\\s*${STR}`, "g"),
  new RegExp(`\\b(?:fail|bad)\\(i,\\s*${STR}`, "g"),
];
const keys = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const re of patterns) for (const m of src.matchAll(re)) keys.add(JSON.parse(`"${m[1]}"`));
  // success messages returned from server actions
  if (/actions\.ts$/.test(f)) for (const m of src.matchAll(new RegExp(`return ${STR};`, "g"))) keys.add(JSON.parse(`"${m[1]}"`));
}
// Default data that is shown through t(): role, category, tier and channel names, export headers.
for (const k of [
  "Administrator", "Management", "Supervisor", "Data entry", "Customer service",
  "Salary", "Advertising", "Rental", "Software & tools", "Other expenses", "Provider rebate", "Other income",
  "High value", "Regular", "Low activity",
  "WhatsApp", "Telegram", "SMS", "Phone call",
  "Brand", "Username", "Name", "Phone", "Tier", "Score", "Currency", "Deposits", "Deposit count", "Withdrawals", "Withdrawal count", "Net", "Avg deposit", "First deposit", "Last deposit", "CS",
  "Your session has ended. Please log in again.", "You don't have permission to do this.", "You don't have access to this brand.",
  "Too many attempts. Try again in {n} min.", "Wrong username or password.", "This account has been disabled. Please contact your administrator.",
])
  keys.add(k);

const STRINGS = [1, 2, 3, 4, 5, 6].flatMap((n) => JSON.parse(fs.readFileSync(path.join(root, "lib", "i18n", `strings-${n}.json`), "utf8")));
const have = new Set(STRINGS.map((s) => s[0]));
const list = [...keys].sort((a, b) => a.localeCompare(b));
const out = process.argv.includes("--all") ? list : list.filter((k) => !have.has(k));
console.log(JSON.stringify(out, null, 0));
console.error(`${list.length} keys, ${list.filter((k) => !have.has(k)).length} missing, ${[...have].filter((k) => !keys.has(k)).length} unused`);
