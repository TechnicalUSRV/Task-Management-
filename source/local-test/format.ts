import { uiText, dynamicLabels } from "./i18n";
// Shared display formatting. One place decides how money, dates, durations and
// missing values look, so every table, card and report reads the same way.

export const MISSING = '—';
// V5.5: times are shown in the signed-in person's time zone (their own, else the company's, else Cambodia's). The
// screens set it once the data is loaded (setDisplayZone); dates without a time (due dates) are never converted.
let TZ = 'Asia/Phnom_Penh';
const MONTHS = dynamicLabels(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], { 0: () => uiText("Jan"), 1: () => uiText("Feb"), 2: () => uiText("Mar"), 3: () => uiText("Apr"), 4: () => uiText("May"), 5: () => uiText("Jun"), 6: () => uiText("Jul"), 7: () => uiText("Aug"), 8: () => uiText("Sep"), 9: () => uiText("Oct"), 10: () => uiText("Nov"), 11: () => uiText("Dec") });

/** Null, undefined and empty strings are "missing"; zero is a real value. */
export const isMissing = (value: unknown) => value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));

const moneyFormatters = new Map<string, Intl.NumberFormat>();
function moneyFormatter(currency: string) {
  let f = moneyFormatters.get(currency);
  if (!f) {
    try { f = new Intl.NumberFormat('en-US', { style: 'currency', currency }); }
    catch { f = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    moneyFormatters.set(currency, f);
  }
  return f;
}

/** Formats integer cents. Returns null when the amount is missing. */
export function formatMoney(cents: unknown, currency = 'USD'): string | null {
  if (isMissing(cents)) return null;
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return moneyFormatter(currency).format(n / 100);
}

/** Compact money for KPI tiles: $12.9K / $4.2M, exact below 10,000. */
export function formatMoneyCompact(cents: unknown, currency = 'USD'): string | null {
  if (isMissing(cents)) return null;
  const n = Number(cents) / 100;
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) < 10000) return moneyFormatter(currency).format(n);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(n); }
  catch { return moneyFormatter(currency).format(n); }
}

const numberFormatter = new Intl.NumberFormat('en-US');
/** Picks the singular or plural noun: plural(1, 'task') → 'task', plural(3, 'task') → 'tasks'. */
export const plural = (n: number, one: string, many = `${one}s`) => uiText(n === 1 ? one : many);

export function formatNumber(value: unknown, digits?: number): string | null {
  if (isMissing(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return digits === undefined ? numberFormatter.format(n) : new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export function formatPercent(value: unknown, digits = 0): string | null {
  if (isMissing(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : null;
}

/** H:MM, the convention used for all recorded and estimated time. */
export function formatDuration(minutes: unknown): string | null {
  if (isMissing(minutes)) return null;
  const n = Math.max(0, Math.round(Number(minutes)));
  if (!Number.isFinite(n)) return null;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

const formatterFor = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
let zoned = formatterFor(TZ);
/** Shows times in this IANA time zone from now on (an invalid zone is ignored). */
export function setDisplayZone(zone: string | null | undefined) {
  if (!zone || zone === TZ) return;
  try { zoned = formatterFor(zone); TZ = zone; } catch { /* keep the previous zone */ }
}
export const displayZone = () => TZ;
/** “Phnom Penh time”, “UTC”. */
export const zoneName = (zone = TZ) => (zone === 'UTC' ? 'UTC' : uiText('{p0} time', { p0: zone.split('/').pop()!.replace(/_/g, ' ') }));
/** The current offset of a zone, “UTC+7”. */
export function zoneOffset(zone: string): string {
  try { return (new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '').replace('GMT', 'UTC'); } catch { return ''; }
}
/** Time zones offered in pickers (the server accepts any IANA zone; a saved zone outside this list still shows). */
export const COMMON_ZONES = ['Asia/Phnom_Penh', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Vientiane', 'Asia/Yangon', 'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Jakarta', 'Asia/Manila',
  'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Dubai', 'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'Africa/Johannesburg', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'UTC'];
export const zoneOptions = (): [string, string][] => COMMON_ZONES.map(z => [z, z === 'UTC' ? 'UTC' : `${z.split('/').pop()!.replace(/_/g, ' ')} (${zoneOffset(z)})`]);
function parts(value: string, zone?: string) {
  const out: Record<string, string> = {};
  for (const p of (zone && zone !== TZ ? formatterFor(zone) : zoned).formatToParts(new Date(value))) out[p.type] = p.value;
  if (out.hour === '24') out.hour = '00';
  return out;
}
/** A timestamp as the value of a datetime-local field in the display zone: “2026-10-05T09:30”. */
export function zonedInput(value: unknown, zone?: string): string {
  if (isMissing(value) || !Number.isFinite(Date.parse(String(value)))) return '';
  const p = parts(String(value), zone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** A datetime-local value (“2026-10-05T09:30”) read in the display zone, as a UTC timestamp. */
export function zonedToIso(local: string, zone = TZ): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || '');
  if (!m) return '';
  const wanted = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = wanted;
  // Two passes settle the offset, also next to a daylight-saving change.
  for (let i = 0; i < 2; i++) { const p = parts(new Date(t).toISOString(), zone); t += wanted - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); }
  // V5.5.1: a time that doesn't exist on a daylight-saving day (the clocks jump over it) moves forward to the first time
  // that does, as calendars do: 02:30 in New York on the spring change becomes 03:30, never 01:30.
  const p = parts(new Date(t).toISOString(), zone), got = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  if (got < wanted) t += wanted - got;
  return new Date(t).toISOString();
}

/** "23 Sep 2026". Date-only strings are shown as stored; timestamps use the display time zone. */
export function formatDate(value: unknown): string | null {
  if (isMissing(value)) return null;
  const s = String(value);
  let y: string, m: string, d: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) [y, m, d] = s.split('-');
  else {
    if (!Number.isFinite(Date.parse(s))) return s;
    const p = parts(s); y = p.year; m = p.month; d = p.day;
  }
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** "23 Sep 2026, 14:30" in the display time zone. */
export function formatDateTime(value: unknown): string | null {
  if (isMissing(value)) return null;
  const s = String(value);
  if (!Number.isFinite(Date.parse(s))) return s;
  const p = parts(s);
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute}`;
}

/** "14:30" in the display time zone. */
export function formatTime(value: unknown): string | null {
  if (isMissing(value)) return null;
  const p = parts(String(value));
  return `${p.hour}:${p.minute}`;
}

/** Month + year for a YYYY-MM value. */
export function formatMonth(value: string) {
  const [y, m] = value.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** Local calendar day (YYYY-MM-DD) in the display time zone. */
export function localDate(value: string | Date = new Date()) {
  const p = parts(typeof value === 'string' ? value : value.toISOString());
  return `${p.year}-${p.month}-${p.day}`;
}

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

/** "Today", "Yesterday", "3 days ago", else the date. */
export function formatRelative(value: unknown, now = new Date()): string | null {
  if (isMissing(value)) return null;
  const s = String(value);
  if (!Number.isFinite(Date.parse(s))) return s;
  const minutes = Math.round((now.getTime() - Date.parse(s)) / 60000);
  if (minutes >= 0 && minutes < 1) return uiText("Just now");
  if (minutes >= 0 && minutes < 60) return `${minutes} min ago`;
  const days = daysBetween(localDate(s), localDate(now));
  if (days === 0) return `Today, ${formatTime(s)}`;
  if (days === 1) return `Yesterday, ${formatTime(s)}`;
  if (days > 1 && days < 7) return `${days} days ago`;
  return formatDate(s);
}

/** "IN_PROGRESS" → "In progress". */
export function humanize(value: unknown): string {
  if (isMissing(value)) return '';
  const s = String(value).replaceAll('_', ' ').trim();
  if (!/[a-z]/.test(s)) return s.charAt(0) + s.slice(1).toLowerCase();
  return s;
}

/** Range label for filters and KPI periods. */
export function formatRange(from?: string, to?: string) {
  if (!from && !to) return uiText("All dates");
  if (from && to) {
    if (from === to) return formatDate(from) as string;
    const [fy, fm] = from.split('-'), [ty, tm] = to.split('-');
    if (fy === ty && fm === tm) return `${Number(from.slice(8))}–${formatDate(to)}`;
    if (fy === ty) return `${formatDate(from)?.replace(` ${fy}`, '')} – ${formatDate(to)}`;
    return `${formatDate(from)} – ${formatDate(to)}`;
  }
  return from ? `From ${formatDate(from)}` : `Until ${formatDate(to)}`;
}

export const initials = (name: string) => String(name || '?').split(/[\s·,-]+/).filter(Boolean).slice(0, 2).map(v => v[0]).join('').toUpperCase() || '?';

/** Stable text comparison for sorting: numbers numerically, text naturally, missing last. */
export function compareValues(a: unknown, b: unknown) {
  const am = isMissing(a), bm = isMissing(b);
  if (am || bm) return am && bm ? 0 : am ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
