/** Display-only task wording. Canonical domain values and employee text stay intact. */
import { uiText } from './i18n';
import { reminderDays } from './task-domain.mjs';

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
