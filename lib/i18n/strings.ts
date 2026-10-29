// Every UI text as [English, Chinese, Indonesian]. Split into files only to keep each one readable.
// Run `node scripts/i18n-keys.mjs` to list texts that still need a translation.
import one from "./strings-1.json";
import two from "./strings-2.json";
import three from "./strings-3.json";
import four from "./strings-4.json";
import five from "./strings-5.json";
import six from "./strings-6.json";
import seven from "./strings-7.json";
import eight from "./strings-8.json";
import nine from "./strings-9.json";
import ten from "./strings-10.json";

export const STRINGS = [...one, ...two, ...three, ...four, ...five, ...six, ...seven, ...eight, ...nine, ...ten] as [string, string, string][];
