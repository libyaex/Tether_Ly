import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, must } from "./supabase";

export interface Profile { id: string; full_name: string; phone: string | null; email: string | null; status: string; created_at: string }
interface Ctx {
  loading: boolean; session: Session | null; profile: Profile | null; perms: string[];
  has: (p: string) => boolean; isStaff: boolean; refresh: () => Promise<void>; signOut: () => Promise<void>;
}
const AuthCtx = createContext<Ctx>({ loading: true, session: null, profile: null, perms: [], has: () => false, isStaff: false, refresh: async () => {}, signOut: async () => {} });
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [perms, setPerms] = useState<string[]>([]);

  const load = useCallback(async (s: Session | null) => {
    if (!s) { setProfile(null); setPerms([]); return; }
    try {
      const [p, pm] = await Promise.all([
        must<Profile>(supabase.from("profiles").select("id,full_name,phone,email,status,created_at").eq("id", s.user.id).single()),
        must<string[]>(supabase.rpc("my_permissions")),
      ]);
      setProfile(p); setPerms(pm ?? []);
    } catch { setProfile(null); setPerms([]); }
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => { if (!alive) return; setSession(data.session); await load(data.session); if (alive) setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); void load(s); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [load]);

  const value = useMemo<Ctx>(() => ({
    loading, session, profile, perms, has: (p) => perms.includes(p), isStaff: perms.length > 0,
    refresh: () => load(session), signOut: async () => { await supabase.auth.signOut(); setProfile(null); setPerms([]); },
  }), [loading, session, profile, perms, load]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
