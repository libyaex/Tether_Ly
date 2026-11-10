import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * True only when real Supabase credentials are present at build time.
 * There is no demo/offline fallback: without credentials the app renders a configuration notice and nothing else.
 */
export const configured = Boolean(url && key && url.startsWith("https://"));

export const supabase: SupabaseClient = createClient(
  configured ? (url as string) : "https://not-configured.invalid",
  configured ? (key as string) : "not-configured",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

/** Unwraps a PostgREST result; throws on error so callers can use try/await. */
export async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}
