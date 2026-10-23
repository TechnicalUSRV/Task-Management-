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

/** Only for developer-owned label maps. Never wrap data returned by an API. */
export function translatedMap<T extends Record<string, string>>(values: T): T {
  return new Proxy(values, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'string' ? uiText(value) : value;
    },
  });
}

/** Label is the second item; identifiers and other tuple values stay intact. */
export function translatedTuples<T extends readonly (readonly unknown[])[]>(values: T): T {
  return values.map(row => dynamicLabels([...row], { 1: () => uiText(String(row[1])) })) as unknown as T;
}

// Some Telegram WebViews/Chromium builds omit Khmer ICU locale data. Translate
// only Intl-owned date parts in that case; time zone and numeric values remain exact.
const dateWords: Record<string, () => string> = {
  Mon: () => uiText('Mon'),
  Tue: () => uiText('Tue'),
  Wed: () => uiText('Wed'),
  Thu: () => uiText('Thu'),
  Fri: () => uiText('Fri'),
  Sat: () => uiText('Sat'),
  Sun: () => uiText('Sun'),
  Monday: () => uiText('Monday'),
  Tuesday: () => uiText('Tuesday'),
  Wednesday: () => uiText('Wednesday'),
  Thursday: () => uiText('Thursday'),
  Friday: () => uiText('Friday'),
  Saturday: () => uiText('Saturday'),
  Sunday: () => uiText('Sunday'),
  Jan: () => uiText('Jan'),
  Feb: () => uiText('Feb'),
  Mar: () => uiText('Mar'),
  Apr: () => uiText('Apr'),
  Jun: () => uiText('Jun'),
  Jul: () => uiText('Jul'),
  Aug: () => uiText('Aug'),
  Sep: () => uiText('Sep'),
  Oct: () => uiText('Oct'),
  Nov: () => uiText('Nov'),
  Dec: () => uiText('Dec'),
  January: () => uiText('January'),
  February: () => uiText('February'),
  March: () => uiText('March'),
  April: () => uiText('April'),
  May: () => uiText('May'),
  June: () => uiText('June'),
  July: () => uiText('July'),
  August: () => uiText('August'),
  September: () => uiText('September'),
  October: () => uiText('October'),
  November: () => uiText('November'),
  December: () => uiText('December'),
  AM: () => uiText('AM'),
  PM: () => uiText('PM'),
  Sept: () => uiText('Sep'),
};
export function formatDisplayDate(value: Date, options: Intl.DateTimeFormatOptions) {
  const locale = getLocale();
  const hasKhmer = current !== 'km' || Intl.DateTimeFormat.supportedLocalesOf(['km-KH']).length > 0;
  const formatter = new Intl.DateTimeFormat(hasKhmer ? locale : 'en-GB', options);
  if (hasKhmer) return formatter.format(value);
  return formatter.formatToParts(value).map(part =>
    ['month', 'weekday', 'dayPeriod'].includes(part.type) ? dateWords[part.value]?.() ?? part.value : part.value
  ).join('');
}
