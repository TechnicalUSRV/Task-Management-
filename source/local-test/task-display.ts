/** Display-only task wording. Canonical domain values and employee text stay intact. */
import { uiText, translatedMap, formatDisplayDate, getLanguage } from './i18n';
import { reminderDays, TASK_STATUS, RECURRENCE } from './task-domain.mjs';

export function joinDisplayNames(values: string[]) {
  return values.length > 1
    ? uiText('{p0} and {p1}', { p0: values.slice(0, -1).join(', '), p1: values[values.length - 1] })
    : values[0] || '';
}

export function relativeDays(days: number) {
  return days === 0 ? uiText('today') : days === 1 ? uiText('tomorrow') : days === -1 ? uiText('yesterday')
    : days > 0 ? uiText('in {p0} days', { p0: days }) : uiText('{p0} days ago', { p0: -days });
}

export function reminderText(value: unknown) {
  const days: number[] = reminderDays(value);
  if (!days.length) return uiText('No reminders');
  const count = joinDisplayNames(days.map(String));
  return days.length === 1 && days[0] === 1
    ? uiText('{p0} day before the due date', { p0: count })
    : uiText('{p0} days before the due date', { p0: count });
}

export function missingFieldsText(fill: string[], choose: string[]) {
  if (fill.length && choose.length) return uiText('Fill in {p0}, and choose {p1}.', { p0: joinDisplayNames(fill), p1: joinDisplayNames(choose) });
  if (fill.length) return uiText('Fill in {p0}.', { p0: joinDisplayNames(fill) });
  return choose.length ? uiText('Choose {p0}.', { p0: joinDisplayNames(choose) }) : '';
}

/** Meeting reminder offsets are display text, never submitted values. */
export function offsetText(minutes: number) {
  if (minutes === 0) return uiText('at the start');
  if (minutes % 1440 === 0) return minutes === 1440
    ? uiText('{p0} day before', { p0: minutes / 1440 }) : uiText('{p0} days before', { p0: minutes / 1440 });
  if (minutes % 60 === 0) return minutes === 60
    ? uiText('{p0} hour before', { p0: minutes / 60 }) : uiText('{p0} hours before', { p0: minutes / 60 });
  return minutes === 1 ? uiText('{p0} minute before', { p0: minutes }) : uiText('{p0} minutes before', { p0: minutes });
}

// Read the field identifier rather than translating arbitrary persisted text.
const CHANGE_FIELDS = translatedMap({
  visibility: 'Task visibility', governing_manager_id: 'Governing manager', title: 'Title',
  description: 'Expectation', progress: 'Progress', start_date: 'Start date', due_date: 'Due date',
  priority: 'Priority', estimate_minutes: 'Estimated effort', pic_id: 'Person in charge',
  supporters: 'Supporting people', reviewer_id: 'Reviewer', department: 'Department',
  department_note: 'Department note', recurrence: 'Repeat', recurrence_rule: 'Repeat schedule',
  recurrence_until: 'Repeat until', related: 'Related record', status: 'Status',
});
const PRIORITIES = translatedMap({ HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' });
const VISIBILITIES = translatedMap({ PERSONAL: 'Personal', PUBLIC: 'Public', ORGANIZATIONAL: 'Organizational' });
const STATES = translatedMap({ ...TASK_STATUS, REOPENED: 'Reopened' });
const REPEATS = translatedMap(RECURRENCE);
type Change = Record<string, any>;
const knownLabel = (labels: Record<string, string>, value: unknown, fallback: string) =>
  typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : fallback;
export function changeFieldLabel(change: Change) {
  return knownLabel(CHANGE_FIELDS, change.field, String(change.label ?? change.field ?? ''));
}
export function changeValueText(change: Change, side: 'from' | 'to') {
  const value = change[side], shown = String(change[side + '_text'] ?? '');
  if (change.field === 'priority') return knownLabel(PRIORITIES, value, shown);
  if (change.field === 'visibility') return knownLabel(VISIBILITIES, value, shown);
  if (change.field === 'recurrence' && value) return knownLabel(REPEATS, value, shown);
  if (change.field === 'supporters' && Array.isArray(value) && !value.length) return uiText('Nobody');
  if (change.field === 'status' && typeof value === 'string' && Object.hasOwn(STATES, value)) {
    // Status summaries may include progress. Preserve that exact numeric suffix.
    const suffix = shown.match(/ · \d+%$/)?.[0] ?? '';
    return knownLabel(STATES, value, shown) + suffix;
  }
  if (['start_date', 'due_date', 'recurrence_until'].includes(change.field) && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value + 'T12:00:00Z');
    if (!Number.isNaN(date.getTime())) return formatDisplayDate(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  // Titles, descriptions, people, departments and unknown/legacy fields stay literal.
  return shown;
}
export function updateChangeTitle(changes: Change[]) {
  const labels = changes.map(change => { const label = changeFieldLabel(change); return getLanguage() === 'en' ? label.toLowerCase() : label; });
  return uiText('Change {p0}', { p0: labels.join(', ') || uiText('details') });
}
export function visibilityLabel(value: string) {
  return knownLabel(VISIBILITIES, value, value);
}
