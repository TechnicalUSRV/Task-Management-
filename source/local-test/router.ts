// Hash-based navigation. Every screen has an address (#/crm/contacts/CONT-000001),
// so refresh, back/forward and bookmarks keep the user where they were. The server
// only ever serves index.html, so no server routing is needed.
import { useCallback, useEffect, useState } from 'react';

export type Route = { path: string; parts: string[]; query: URLSearchParams };

export function parseRoute(hash = typeof window === 'undefined' ? '' : window.location.hash): Route {
  const raw = hash.replace(/^#/, '') || '/dashboard';
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  return { path: '/' + parts.join('/'), parts: parts.length ? parts : ['dashboard'], query: new URLSearchParams(queryPart) };
}

export const routeHref = (path: string) => '#' + path;

export function buildPath(parts: (string | undefined | null)[], query?: Record<string, string | undefined>) {
  const path = '/' + parts.filter(Boolean).map(p => encodeURIComponent(String(p))).join('/');
  const q = new URLSearchParams(Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString();
  return q ? `${path}?${q}` : path;
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  useEffect(() => {
    const onChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((path: string, options: { replace?: boolean } = {}) => {
    const next = '#' + path;
    if (window.location.hash === next) { setRoute(parseRoute(next)); return; }
    if (options.replace) { window.history.replaceState(null, '', next); setRoute(parseRoute(next)); }
    else window.location.hash = path;
  }, []);
  return { route, navigate };
}

// View state (search, filters, sort, page) that should survive leaving a list and
// coming back. Kept for the browser session only; nothing is sent to the server.
const memory = new Map<string, unknown>();
const storageKey = (key: string) => `sunny-erp:view:${key}`;
function readStored<T>(key: string, fallback: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = window.sessionStorage.getItem(storageKey(key));
    if (raw) { const value = JSON.parse(raw) as T; memory.set(key, value); return value; }
  } catch { /* storage unavailable: fall back to memory only */ }
  return fallback;
}
function writeStored(key: string, value: unknown) {
  memory.set(key, value);
  try { window.sessionStorage.setItem(storageKey(key), JSON.stringify(value)); } catch { /* ignore */ }
}

/** useState that remembers its value for this browser session under `key`. */
export function useViewState<T>(key: string | undefined, initial: T): [T, (value: T | ((old: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (key ? readStored(key, initial) : initial));
  useEffect(() => { if (key) setValue(readStored(key, initial)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  const update = useCallback((next: T | ((old: T) => T)) => {
    setValue(old => {
      const resolved = typeof next === 'function' ? (next as (old: T) => T)(old) : next;
      if (key) writeStored(key, resolved);
      return resolved;
    });
  }, [key]);
  return [value, update];
}
