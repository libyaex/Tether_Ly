// Minimal History-API router (no dependency): static + :param segments, query string, Link, navigation.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from "react";

interface Nav { path: string; search: string; navigate: (to: string, opts?: { replace?: boolean }) => void }
const NavCtx = createContext<Nav>({ path: "/", search: "", navigate: () => {} });
const ParamsCtx = createContext<Record<string, string>>({});

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState({ path: window.location.pathname, search: window.location.search });
  useEffect(() => {
    const on = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener("popstate", on); return () => window.removeEventListener("popstate", on);
  }, []);
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    const u = new URL(to, window.location.origin);
    if (u.origin !== window.location.origin) { window.location.href = to; return; }   // external redirect (e.g. DPay hosted page)
    window.history[opts?.replace ? "replaceState" : "pushState"](null, "", u.pathname + u.search);
    setLoc({ path: u.pathname, search: u.search }); window.scrollTo(0, 0);
  }, []);
  const value = useMemo(() => ({ ...loc, navigate }), [loc, navigate]);
  return <NavCtx.Provider value={value}>{children}</NavCtx.Provider>;
}
export const useNav = () => useContext(NavCtx);
export const useParams = () => useContext(ParamsCtx);
export const useSearch = () => new URLSearchParams(useContext(NavCtx).search);

export function Link({ to, onClick, children, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useNav();
  return (
    <a href={to} {...rest} onClick={(e) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || rest.target === "_blank") return;
      e.preventDefault(); navigate(to);
    }}>{children}</a>
  );
}

export interface Route { path: string; element: ReactNode | ((p: Record<string, string>) => ReactNode) }
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean), b = path.split("/").filter(Boolean);
  if (pattern.endsWith("/*")) { a.pop(); if (b.length < a.length) return null; } else if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
export function Routes({ routes, fallback }: { routes: Route[]; fallback: ReactNode }) {
  const { path } = useNav();
  for (const r of routes) {
    const params = matchPath(r.path, path);
    if (params) return <ParamsCtx.Provider value={params}>{typeof r.element === "function" ? r.element(params) : r.element}</ParamsCtx.Provider>;
  }
  return <>{fallback}</>;
}
export function Redirect({ to }: { to: string }) {
  const { navigate } = useNav();
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return null;
}
