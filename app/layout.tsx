import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { I18nProvider } from "@/components/i18n";
import { dictFor, getLang } from "@/lib/i18n-server";
import { getSettings } from "@/lib/settings";

export async function generateMetadata(): Promise<Metadata> {
  const s = await getSettings().catch(() => null);
  return { title: s?.systemName ?? "Business Analytics", description: "Multi-brand data management and analytics" };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const lang = await getLang();
  return (
    <html lang={lang === "zh" ? "zh-CN" : lang} className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full">
        {/* Apply the saved theme before the page shows, so it doesn't flash. Light is the default. */}
        <Script id="theme" strategy="beforeInteractive">
          {`try{if(localStorage.getItem("theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`}
        </Script>
        <I18nProvider lang={lang} dict={dictFor(lang)}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
