"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/components/i18n";
import { KIND_LABEL, type AlertKindName } from "@/lib/alert-text";

type Item = { id: number; kind: AlertKindName; player: string; playerId: number; brand: string; title: string; detail: string };

const TONE: Record<AlertKindName, string> = {
  NEAR: "border-l-brand",
  ELIGIBLE: "border-l-good",
  EXPIRING: "border-l-warning",
  RECALLED: "border-l-good",
  REFOLLOW: "border-l-[var(--line-strong)]",
};

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start();
    o.stop(ctx.currentTime + 0.35);
  } catch {}
}

/** Bell in the top bar: number of open alerts, and a pop-up for each new one. */
export function AlertBell({ pollSeconds, popup, sound }: { pollSeconds: number; popup: boolean; sound: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Item[]>([]);
  const since = useRef(0);
  const t = useT();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await fetch(`/api/alerts?since=${since.current}`, { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { open: number; now?: number; items: Item[] };
          if (!stop) {
            setOpen(j.open);
            if (since.current && j.items.length) {
              if (popup) setToasts((list) => [...j.items.filter((i) => !list.some((x) => x.id === i.id)), ...list].slice(0, 4));
              if (sound) beep();
              if (path === "/alerts") router.refresh();
            }
            if (j.now) since.current = j.now;
          }
        }
      } catch {}
      if (!stop) timer = setTimeout(poll, Math.max(5, pollSeconds) * 1000);
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [pollSeconds, popup, sound, path, router]);

  useEffect(() => {
    if (!toasts.length) return;
    const timer = setTimeout(() => setToasts((l) => l.slice(0, -1)), 20_000);
    return () => clearTimeout(timer);
  }, [toasts]);

  const popups = (
    <div className="fixed right-4 bottom-4 z-50 w-[min(22rem,calc(100vw-2rem))] space-y-2" role="status">
      {toasts.map((a) => (
        <div key={a.id} className={`rounded-xl border border-l-4 border-line bg-surface p-3 text-sm shadow-xl ${TONE[a.kind]}`}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted">
                {t(KIND_LABEL[a.kind])} · {a.brand}
              </div>
              <div className="mt-0.5 font-medium">
                {a.player} · {a.title}
              </div>
              <div className="mt-0.5 text-ink-2">{a.detail}</div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm -mt-1 -mr-1" aria-label={t("Close")} onClick={() => setToasts((l) => l.filter((x) => x.id !== a.id))}>
              ✕
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <Link href={`/alerts?focus=${a.id}`} className="btn btn-sm btn-primary" onClick={() => setToasts((l) => l.filter((x) => x.id !== a.id))}>
              {t("Open")}
            </Link>
            <Link href={`/players/${a.playerId}`} className="btn btn-sm">
              {t("Player")}
            </Link>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <Link href="/alerts" className="btn btn-ghost btn-sm relative" title={t("Follow-up alerts")} aria-label={t("Follow-up alerts")}>
        <span aria-hidden>🔔</span>
        {!!open && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-critical px-1 text-center text-[10px] leading-4 font-semibold text-white">
            {open > 99 ? "99+" : open}
          </span>
        )}
      </Link>
      {/* On <body>: the blurred top bar would otherwise pin the pop-ups to itself. */}
      {toasts.length > 0 && createPortal(popups, document.body)}
    </>
  );
}
