import { useSyncExternalStore } from 'react';
import khmer from '../../translations/km.json';
import chinese from '../../translations/zh-CN.json';

export type Language = 'en' | 'km' | 'zh-CN';
export const LANGUAGES: readonly { value: Language; name: string }[] = [
  { value: 'en', name: 'English' }, { value: 'km', name: 'ភាសាខ្មែរ' }, { value: 'zh-CN', name: '简体中文' },
];
const catalogs: Record<string, Record<string, string>> = { km: khmer, 'zh-CN': chinese };
const listeners = new Set<() => void>();
let current: Language = 'en', revision = 0;
const normalize = (value: unknown): Language => LANGUAGES.some(l => l.value === value) ? value as Language : 'en';
export const getLanguage = () => current;
export const getLanguageRevision = () => revision;
export const getLocale = () => current === 'en' ? 'en-GB' : current === 'km' ? 'km-KH' : 'zh-CN';
export function setLanguage(value: unknown) {
  const next = normalize(value);
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (next === current) return;
  current = next; revision++;
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useLanguage = () => useSyncExternalStore(subscribe, getLanguage, () => 'en' as Language);
export function receiveLanguage(response: Response, requestRevision: number) {
  const saved = response.headers.get('X-Account-Language');
  if (saved && revision === requestRevision) setLanguage(saved);
}

/** Translate only an explicitly marked interface template. Values are never translated. */
export function uiText(source: string, params: Record<string, unknown> = {}, language: Language = current): string {
  const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(m => m[1]).sort().join('|');
  let translated = catalogs[language]?.[source] || source;
  if (placeholders(translated) !== placeholders(source)) translated = source;
  return translated.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key] ?? '') : match);
}

/** Static, code-owned option lists only. IDs/values remain canonical; labels are read in the current language. */
export function localizedLabels<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  return new Proxy(value as object, {
    get(target, key, receiver) {
      const result = Reflect.get(target, key, receiver);
      if (typeof result === 'string' && (typeof key === 'string') && ['label', 'title', 'description', 'hint', 'note'].includes(key)) return uiText(result);
      return result && typeof result === 'object' ? localizedLabels(result) : result;
    },
  }) as T;
}

/** Lazily resolve code-owned labels in constant tuples when the language changes. */
export function dynamicLabels<T extends readonly unknown[]>(items: T, labels: Record<number, () => string>): T {
  for (const [key, read] of Object.entries(labels)) Object.defineProperty(items, key, { enumerable: true, configurable: true, get: read });
  return items;
}

/** Code-owned label maps. Keep identifiers stable and resolve labels lazily. */
export function translatedEntries(values: Record<string, string>): [string, string][] {
  return Object.keys(values).map(key => dynamicLabels([key, values[key]] as [string, string], { 1: () => uiText(values[key]) }));
}
