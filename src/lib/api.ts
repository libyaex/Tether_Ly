import { supabase } from "./supabase";
import { ApiError } from "./errors";

async function toApiError(err: any): Promise<ApiError> {
  try {
    const res = err?.context;
    if (res && typeof res.json === "function") {
      const body = await res.json();
      return new ApiError(String(body?.error ?? "internal_error"), res.status);
    }
  } catch { /* fall through */ }
  return new ApiError(err?.name === "FunctionsFetchError" ? "network" : "internal_error");
}

/** Business action via the `api` Edge Function. Identity comes from the JWT, never from params. */
export async function api<T = any>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("api", { body: { action, params } });
  if (error) throw await toApiError(error);
  return (data as { data: T }).data;
}
/** Other Edge Functions (create-deposit, verify-deposit, export-csv). */
export async function fn<T = any>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw await toApiError(error);
  return data as T;
}
export function saveText(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
