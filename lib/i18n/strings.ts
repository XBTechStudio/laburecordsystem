// Every UI text as [English, Chinese, Indonesian]. Split into files only to keep each one readable.
// Run `node scripts/i18n-keys.mjs` to list texts that still need a translation.
import one from "./strings-1.json";
import two from "./strings-2.json";
import three from "./strings-3.json";
import four from "./strings-4.json";
import five from "./strings-5.json";

export const STRINGS = [...one, ...two, ...three, ...four, ...five] as [string, string, string][];
