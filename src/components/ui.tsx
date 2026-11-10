import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Icon } from "./Icon";
import type { Label } from "../lib/labels";
import { errorMessage } from "../lib/errors";
import type { AsyncState } from "../lib/hooks";
import { useToast } from "../lib/toast";

export function Button({ variant, size, block, busy, accent, gold, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "accent" | "ghost" | "danger" | "gold"; size?: "sm"; block?: boolean; busy?: boolean; accent?: boolean; gold?: boolean }) {
  const v = variant || (accent ? "accent" : gold ? "gold" : undefined);
  return (
    <button {...p} disabled={p.disabled || busy} className={["btn", v, size, block && "block", p.className].filter(Boolean).join(" ")}>
      {busy && <span className="spin" aria-hidden="true" />}{children}
    </button>
  );
}
export function GoogleButton({ label, onSuccess }: { label: string; onSuccess?: () => void }) {
  const [busy, setBusy] = useState(false); const toast = useToast();
  return (
    <Button block busy={busy} className="google-btn" onClick={async () => {
      setBusy(true);
      try {
        const { supabase } = await import("../lib/supabase");
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: `${location.origin}/app`, queryParams: { prompt: "select_account" } },
        });
        if (error) {
          setBusy(false);
          toast("bad", "تعذّر بدء تسجيل الدخول عبر Google");
        } else {
          setBusy(false);
          toast("ok", "تم تسجيل الدخول بنجاح عبر حساب Google");
          if (onSuccess) onSuccess();
        }
      } catch {
        setBusy(false);
        toast("bad", "حدث خطأ غير متوقع");
      }
    }}>
      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" style={{ flex: "none" }}><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.6 32.9 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.1 8 3.1l5.7-5.7C34.6 6 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3.1 0 5.9 1.1 8 3.1l5.7-5.7C34.6 6 29.6 4 24 4c-7.6 0-14.1 4.3-17.4 10.7z"/><path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.6C29.6 35.1 26.9 36 24 36c-5.2 0-9.6-3.1-11.3-7.6l-6.6 5.1C9.8 39.6 16.3 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.4-2.4 4.4-4.5 5.8l6.6 5.6C40.6 36.5 44 30.8 44 24c0-1.3-.1-2.7-.4-3.5z"/></svg>
      <span style={{ fontWeight: 600 }}>{label}</span>
    </Button>
  );
}
export function Field({ label, hint, error, children, id }: { label: string; hint?: string; error?: string | null; children: ReactNode; id: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>{children}
      {error ? <div className="err" role="alert">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
export const Input = ({ invalid, ...p }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) => <input {...p} aria-invalid={invalid || undefined} className={["input", p.className].filter(Boolean).join(" ")} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={["input", p.className].filter(Boolean).join(" ")} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={["input", p.className].filter(Boolean).join(" ")} />;

export const Card = ({ children, className, title, sub }: { children: ReactNode; className?: string; title?: string; sub?: string }) => (
  <section className={["card", className].filter(Boolean).join(" ")}>{title && <h2>{title}</h2>}{sub && <p className="muted small">{sub}</p>}{children}</section>
);
const TONE_ICON = { ok: "check", bad: "x", wait: "clock", info: "info", warn: "alert" } as const;
export function Badge({ label }: { label: Label }) {   // icon + text: state is never conveyed by colour alone
  return <span className={`badge ${label.tone}`}><Icon name={TONE_ICON[label.tone]} size={14} />{label.text}</span>;
}
export const Banner = ({ tone, children, icon }: { tone: "info" | "warn" | "bad" | "ok"; children: ReactNode; icon?: string }) => (
  <div className={`banner ${tone}`} role={tone === "bad" ? "alert" : "status"}><Icon name={icon ?? (tone === "ok" ? "check" : tone === "info" ? "info" : "alert")} size={20} /><div>{children}</div></div>
);
export const Stat = ({ k, v, hero }: { k: string; v: ReactNode; hero?: boolean }) => <div className={`stat${hero ? " hero" : ""}`}><div className="k">{k}</div><div className="v num">{v}</div></div>;
export const Skeleton = ({ lines = 3 }: { lines?: number }) => <div aria-busy="true" aria-label="جارٍ التحميل">{Array.from({ length: lines }, (_, i) => <div key={i} className="skel" style={{ width: `${90 - i * 12}%` }} />)}</div>;
export const Empty = ({ icon = "file", children }: { icon?: string; children: ReactNode }) => <div className="empty"><Icon name={icon} size={40} /><div>{children}</div></div>;
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div className="errbox" role="alert"><Icon name="alert" size={40} /><p>{errorMessage(error)}</p>{retry && <Button variant="ghost" size="sm" onClick={retry}><Icon name="refresh" size={16} />إعادة المحاولة</Button>}</div>;
}
/** Renders loading / error / data for a useAsync() state. */
export function Async<T>({ state, children, lines }: { state: AsyncState<T>; children: (d: T) => ReactNode; lines?: number }) {
  if (state.data !== undefined) return <>{children(state.data)}</>;
  if (state.error) return <ErrorBox error={state.error} retry={state.reload} />;
  return <Skeleton lines={lines} />;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null; ref.current?.focus();
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on); return () => { window.removeEventListener("keydown", on); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="row between"><h2>{title}</h2><button className="iconbtn" style={{ color: "var(--text)" }} onClick={onClose} aria-label="إغلاق"><Icon name="x" /></button></div>
        {children}
      </div>
    </div>
  );
}
/** Every irreversible/financial action goes through an explicit confirmation. */
export function Confirm({ title, body, confirmText, danger, onConfirm, onClose }: { title: string; body: ReactNode; confirmText: string; danger?: boolean; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false); const toast = useToast();
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">{body}
        <div className="row"><Button variant={danger ? "danger" : undefined} busy={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { toast("bad", errorMessage(e)); setBusy(false); } }}>{confirmText}</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>رجوع</Button></div>
      </div>
    </Modal>
  );
}
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return <div className="tabs" role="tablist">{items.map((i) => <button key={i.id} role="tab" aria-selected={value === i.id} onClick={() => onChange(i.id)}>{i.label}</button>)}</div>;
}
export function Pager({ page, pageSize, count, onPage }: { page: number; pageSize: number; count: number; onPage: (p: number) => void }) {
  const last = Math.max(0, Math.ceil(count / pageSize) - 1);
  return (
    <div className="pager"><Button variant="ghost" size="sm" disabled={page <= 0} onClick={() => onPage(page - 1)}><Icon name="right" size={16} />السابق</Button>
      <span className="small muted">صفحة {page + 1} من {last + 1} · {count} نتيجة</span>
      <Button variant="ghost" size="sm" disabled={page >= last} onClick={() => onPage(page + 1)}>التالي<Icon name="left" size={16} /></Button></div>
  );
}
export interface Col<R> { key: string; label: string; render?: (r: R) => ReactNode; sortable?: boolean }
export function DataTable<R extends { id?: string }>({ cols, rows, onRow, empty, sort, onSort }: { cols: Col<R>[]; rows: R[]; onRow?: (r: R) => void; empty?: ReactNode; sort?: { key: string; asc: boolean }; onSort?: (key: string) => void }) {
  if (!rows.length) return <Empty>{empty ?? "لا توجد بيانات"}</Empty>;
  return (
    <div className="table-wrap"><table className="rt"><thead><tr>
      {cols.map((c) => <th key={c.key} aria-sort={sort?.key === c.key ? (sort.asc ? "ascending" : "descending") : undefined}>
        {c.sortable && onSort ? <button className="btn ghost sm" style={{ minHeight: 32, padding: "0 .4rem" }} onClick={() => onSort(c.key)}>{c.label}{sort?.key === c.key ? (sort.asc ? " ▲" : " ▼") : ""}</button> : c.label}</th>)}
    </tr></thead><tbody>
      {rows.map((r, i) => (
        <tr key={r.id ?? i} className={onRow ? "click" : undefined} onClick={() => onRow?.(r)} tabIndex={onRow ? 0 : undefined} onKeyDown={(e) => e.key === "Enter" && onRow?.(r)}>
          {cols.map((c) => <td key={c.key} data-label={c.label}>{c.render ? c.render(r) : String((r as any)[c.key] ?? "—")}</td>)}
        </tr>))}
    </tbody></table></div>
  );
}
export function CopyText({ text, label }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <span className="row" style={{ gap: ".4rem", display: "inline-flex" }}>
      <span className="mono">{text}</span>
      <button className="btn ghost sm" style={{ minHeight: 36, padding: "0 .5rem" }} aria-label={label ?? "نسخ"} onClick={async () => { try { await navigator.clipboard.writeText(text); toast("ok", "تم النسخ"); } catch { toast("bad", "تعذّر النسخ"); } }}><Icon name="copy" size={16} /></button>
    </span>
  );
}
/** Runs an async action with busy state + toast feedback. */
export function useAction() {
  const toast = useToast(); const [busy, setBusy] = useState(false);
  return { busy, run: async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(true); try { const r = await fn(); if (okMsg) toast("ok", okMsg); return r; } catch (e) { toast("bad", errorMessage(e)); return undefined; } finally { setBusy(false); } } };
}
