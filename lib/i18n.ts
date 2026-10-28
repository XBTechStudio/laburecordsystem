// Translation helpers shared by server and browser code.
// Texts are written in English in the code and looked up in the dictionaries by that English text;
// anything missing falls back to English, so a new screen never shows an empty label.

export const LANGS = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "id", label: "Bahasa Indonesia" },
] as const;

export type Lang = (typeof LANGS)[number]["code"];
export type Dict = Record<string, string>;
export type T = (text: string, vars?: Record<string, string | number>) => string;

/** Marks a text that is translated later, where it is shown. Lets the key extractor find it. */
export const tk = (text: string) => text;

export const isLang = (v: unknown): v is Lang => LANGS.some((l) => l.code === v);

export function makeT(dict: Dict | null): T {
  return (text, vars) => {
    let out = (dict && dict[text]) || text;
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
    return out;
  };
}

/** Locale for dates and month names. */
export const LOCALE: Record<Lang, string> = { en: "en-GB", zh: "zh-CN", id: "id-ID" };
