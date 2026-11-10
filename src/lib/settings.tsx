// Public platform settings (branding, switches, content) loaded from admin_settings (is_public rows only).
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { supabase, must } from "./supabase";
import { useAsync } from "./hooks";
import { setTimezone } from "./format";

export type Settings = Record<string, any>;
interface Ctx { s: Settings; loading: boolean; error: boolean; reload: () => void }
const SettingsCtx = createContext<Ctx>({ s: {}, loading: true, error: false, reload: () => {} });
export const useSettings = () => useContext(SettingsCtx);

const HEX = /^#[0-9a-fA-F]{6}$/;
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { data, error, loading, reload } = useAsync(async () => {
    const rows = await must<{ key: string; value: any }[]>(supabase.from("admin_settings").select("key,value"));
    return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Settings;
  }, []);
  const s = data ?? {};
  useEffect(() => {
    const root = document.documentElement;
    // colours are validated as #RRGGBB before they ever reach the DOM
    if (HEX.test(s["platform.primary_color"] ?? "")) root.style.setProperty("--primary", s["platform.primary_color"]);
    if (HEX.test(s["platform.accent_color"] ?? "")) root.style.setProperty("--accent", s["platform.accent_color"]);
    if (s["platform.name"]) document.title = String(s["platform.name"]);
    if (s["platform.timezone"]) setTimezone(String(s["platform.timezone"]));
  }, [data]);

  useEffect(() => {
    function onSync() {
      reload();
    }
    window.addEventListener("settings-updated", onSync);
    window.addEventListener("db-updated", onSync);
    window.addEventListener("storage", onSync);
    return () => {
      window.removeEventListener("settings-updated", onSync);
      window.removeEventListener("db-updated", onSync);
      window.removeEventListener("storage", onSync);
    };
  }, [reload]);

  const value = useMemo(() => ({ s, loading, error: Boolean(error), reload }), [data, loading, error, reload]);
  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>;
}
