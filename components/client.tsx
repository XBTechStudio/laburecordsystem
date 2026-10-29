"use client";

import { createContext, useActionState, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n";

export type Result = { ok: boolean; message: string; at: number; data?: unknown; warn?: boolean } | null;
type Action = (prev: Result, fd: FormData) => Promise<Result>;

const DialogClose = createContext<(() => void) | null>(null);

/**
 * A form that runs a server action and shows its result right under the fields.
 * `reset` clears the inputs after a successful save so the next entry can start straight away.
 */
export function ActionForm({
  action,
  children,
  className = "",
  reset = false,
  close = false,
  onDone,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  reset?: boolean;
  /** Inside a Dialog: close it after a successful save. */
  close?: boolean;
  onDone?: (r: Result) => void;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const closeDialog = useContext(DialogClose);
  useEffect(() => {
    if (!state) return;
    if (state.ok && reset) ref.current?.reset();
    if (state.ok && close) closeDialog?.();
    onDone?.(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.at]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      <Message state={state} />
    </form>
  );
}

export function Message({ state }: { state: Result }) {
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (!state) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShown(state.at);
    if (state.ok && !state.warn) {
      const t = setTimeout(() => setShown(null), 4000);
      return () => clearTimeout(t);
    }
  }, [state]);
  if (!state || shown !== state.at) return null;
  return (
    <div
      role="status"
      className={`mt-3 rounded-lg px-3 py-2 text-sm ${state.warn ? "bg-warning-soft text-warning-ink" : state.ok ? "bg-good-soft text-good-ink" : "bg-critical-soft text-critical-ink"}`}
    >
      {state.ok && !state.warn ? "✓ " : state.warn ? "⚠ " : ""}
      {state.message}
    </div>
  );
}

export function Submit({ children, pending, className = "btn btn-primary" }: { children: ReactNode; pending?: string; className?: string }) {
  const { pending: busy } = useFormStatus();
  const t = useT();
  return (
    <button type="submit" disabled={busy} className={className}>
      {busy ? (pending ?? t("Saving…")) : children}
    </button>
  );
}

/** Submit button that asks first. */
export function ConfirmSubmit({ children, question, className = "btn btn-sm" }: { children: ReactNode; question: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={className}
      onClick={(e) => {
        if (!confirm(question)) e.preventDefault();
      }}
    >
      {pending ? "…" : children}
    </button>
  );
}

/** One-click server action (delete, toggle…) with an optional confirm, refreshing the page afterwards. */
export function ActionButton({
  action,
  fields,
  children,
  question,
  className = "btn btn-sm",
}: {
  action: Action;
  fields: Record<string, string | number>;
  children: ReactNode;
  question?: string;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state && !state.ok) alert(state.message);
  }, [state]);
  return (
    <form action={formAction} className="inline">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {question ? <ConfirmSubmit question={question} className={className}>{children}</ConfirmSubmit> : <Submit className={className} pending="…">{children}</Submit>}
    </form>
  );
}

export function Dialog({
  label,
  title,
  children,
  className = "btn btn-sm",
  wide = false,
}: {
  label: ReactNode;
  title: string;
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const t = useT();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const close = () => setOpen(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        className={`m-auto w-[calc(100%-2rem)] ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl border border-line bg-surface p-0 text-left font-normal whitespace-normal text-ink shadow-2xl backdrop:bg-black/40`}
      >
        <div className="flex items-center border-b border-line px-5 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button type="button" onClick={close} className="btn btn-ghost btn-sm ml-auto" aria-label={t("Close")}>
            ✕
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-5">
          <DialogClose.Provider value={close}>{open && children}</DialogClose.Provider>
        </div>
      </dialog>
    </>
  );
}

/** A <select> that submits its GET form as soon as it changes. */
export function AutoSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const t = useT();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(document.documentElement.dataset.theme === "dark");
  }, []);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      title={dark ? t("Switch to light") : t("Switch to dark")}
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.dataset.theme = next ? "dark" : "light";
        try {
          localStorage.setItem("theme", next ? "dark" : "light");
        } catch {}
      }}
    >
      {dark ? "☀ " + t("Light") : "☾ " + t("Dark")}
    </button>
  );
}

export function BrandSwitcher({
  brands,
  current,
  action,
}: {
  brands: { id: number; name: string }[];
  current: number | null;
  action: (id: string) => Promise<void>;
}) {
  const router = useRouter();
  const t = useT();
  if (brands.length <= 1) return brands[0] ? <span className="text-sm font-medium">{brands[0].name}</span> : null;
  return (
    <select
      aria-label={t("Brand")}
      className="input h-8 w-auto max-w-48 font-medium"
      value={current ?? "all"}
      onChange={async (e) => {
        await action(e.target.value);
        router.refresh();
      }}
    >
      <option value="all">{t("All brands")}</option>
      {brands.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}
