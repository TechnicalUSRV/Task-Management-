import { uiText, useLanguage } from "../i18n";
import {Identity} from '../identity-ui';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, Search, UserPlus, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Avatar } from './display';

// V5.3 people pickers: everyone who can be chosen is listed with their photo, name and department, with a search box,
// so people recognise one another. Used for the person in charge, reviewer, supporting people, requests and more.
export type PersonOption = { id: string; name: string; detail?: string; note?: string; you?: boolean };

/** The searchable list inside a picker. The search box moves through the list with the arrow keys. */
function PersonList({ people, selected, onPick, label, empty = 'Nobody matches your search.' }: { people: PersonOption[]; selected: string[]; onPick: (id: string) => void; label: string; empty?: string }) {
  useLanguage();
  const [query, setQuery] = useState(''), [active, setActive] = useState(0), listId = useId(), listRef = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => { const q = query.trim().toLowerCase(); return q ? people.filter(p => `${p.name} ${p.detail || ''}`.toLowerCase().includes(q)) : people; }, [query, people]);
  useEffect(() => { setActive(a => Math.min(a, Math.max(0, shown.length - 1))); }, [shown.length]);
  useEffect(() => { listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const optionId = (p?: PersonOption) => (p ? `${listId}-${p.id.replace(/[^A-Za-z0-9_-]/g, '_')}` : undefined);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(Math.max(0, shown.length - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) onPick(shown[active].id); }
  };
  return (
    <div className="person-list-popup">
      <div className="person-search">
        <Search aria-hidden="true" />
        <input type="text" autoFocus value={query} onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey} placeholder={uiText("Search by name or department")}
          role="combobox" aria-label={uiText("Search {p0}", { p0: label.toLowerCase() })} aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={shown.length ? optionId(shown[active]) : undefined} autoComplete="off" spellCheck={false} />
      </div>
      {shown.length ? (
        <ul id={listId} role="listbox" aria-label={label} className="person-options" ref={listRef}>
          {shown.map((p, i) => (
            <li key={p.id} id={optionId(p)} role="option" aria-selected={selected.includes(p.id)} className={cn('person-option', i === active && 'is-active')}
              onMouseMove={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => onPick(p.id)}>
              <Avatar name={p.name} size="sm" />
              <span className="person-option-text">
                <span className="person-option-name"><Identity name={p.name}/>{p.you && <span className="muted"> {uiText("(you)")}</span>}</span>
                {(p.detail || p.note) && <small>{[p.detail, p.note].filter(Boolean).join(' · ')}</small>}
              </span>
              {selected.includes(p.id) && <Check className="person-option-check" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      ) : <p id={listId} className="person-empty" role="status">{people.length ? empty : uiText("Nobody else can be chosen yet.")}</p>}
    </div>
  );
}

type PersonPickerProps = {
  label: string; value?: string | null; onChange: (id: string) => void; people: PersonOption[]; required?: boolean; disabled?: boolean; hint?: ReactNode; error?: string;
  wide?: boolean; className?: string; fieldKey?: string; placeholder?: string; allowNone?: boolean; noneLabel?: string; hideLabel?: boolean;
};
/** One person, chosen from a searchable list with photos. */
export function PersonPicker({ label, value, onChange, people, required, disabled, hint, error, wide, className, fieldKey, placeholder = uiText('Choose a person…'), allowNone, noneLabel = uiText('Nobody'), hideLabel }: PersonPickerProps) {
  useLanguage();
  const [open, setOpen] = useState(false), id = useId(), hintId = hint ? `${id}-hint` : undefined, errorId = error ? `${id}-error` : undefined;
  const current = value ? people.find(p => p.id === value) || { id: value, name: value } : null;
  return (
    <div className={cn('field', wide && 'span-2', error && 'has-error', className)} data-field={fieldKey}>
      <span className={cn('field-label', hideLabel && 'sr-only')} id={`${id}-label`}>{label}{required && <span className="field-required" aria-hidden="true">*</span>}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" id={id} className={cn('person-trigger', !current && 'is-empty')} disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
            aria-labelledby={`${id}-label ${id}-value`} aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined} aria-invalid={!!error || undefined}>
            {current ? <Avatar name={current.name} size="sm" /> : null}
            <span className="person-trigger-text" id={`${id}-value`}>
              {current ? <><span className="person-trigger-name"><Identity name={current.name}/>{(current as PersonOption).you && <span className="muted"> {uiText("(you)")}</span>}</span>{(current as PersonOption).detail && <small>{(current as PersonOption).detail}</small>}</>
                : <span className="person-trigger-placeholder">{allowNone ? noneLabel : placeholder}{required && <span className="sr-only"> {uiText("(required)")}</span>}</span>}
            </span>
            <ChevronDown aria-hidden="true" className="person-trigger-chevron" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="person-popover" aria-label={uiText("Choose: {p0}", { p0: label })}>
          <PersonList people={people} selected={value ? [value] : []} label={label} onPick={v => { onChange(v); setOpen(false); }} />
          {allowNone && value && <button type="button" className="person-clear" onClick={() => { onChange(''); setOpen(false); }}><X aria-hidden="true" />{noneLabel}</button>}
        </PopoverContent>
      </Popover>
      {error && <p id={errorId} className="field-error">{error}</p>}
      {hint && <p id={hintId} className="field-hint">{hint}</p>}
    </div>
  );
}

type PeoplePickerProps = {
  label: string; value: string[]; onChange: (ids: string[]) => void; people: PersonOption[]; hint?: ReactNode; error?: string; className?: string;
  addLabel?: string; empty?: ReactNode; max?: number; note?: (id: string) => ReactNode; disabled?: boolean; locked?: string[];
};
/** Several people, shown as removable chips with photos, added from a searchable list. */
export function PeoplePicker({ label, value, onChange, people, hint, error, className, addLabel = uiText('Add a person'), empty, max, note, disabled, locked = [] }: PeoplePickerProps) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const byId = new Map(people.map(p => [p.id, p]));
  const chosen = value.map(id => byId.get(id) || { id, name: id }), available = people.filter(p => !value.includes(p.id));
  const full = !!max && value.length >= max;
  return (
    <fieldset className={cn("people-field span-2", error && 'has-error', className)} disabled={disabled}>
      <legend className="field-label">{label}</legend>
      <ul className="people-chips">
        {chosen.map(p => (
          <li key={p.id} className="person-chip">
            <Avatar name={p.name} size="sm" />
            <span className="person-chip-text"><span className="person-chip-name"><Identity name={p.name}/>{(p as PersonOption).you && <span className="muted"> {uiText("(you)")}</span>}</span>{note?.(p.id)}</span>
            {!locked.includes(p.id) && !disabled && <button type="button" className="person-chip-remove" aria-label={uiText("Remove {p0}", { p0: p.name })} onClick={() => onChange(value.filter(x => x !== p.id))}><X aria-hidden="true" /></button>}
          </li>
        ))}
        {!disabled && <li className="person-chip-add">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="person-add" disabled={disabled || !available.length || full} aria-haspopup="dialog" aria-expanded={open}><UserPlus aria-hidden="true" />{addLabel}</button>
            </PopoverTrigger>
            <PopoverContent align="start" className="person-popover" aria-label={uiText("{p0}: {p1}", { p0: addLabel, p1: label })}>
              <PersonList people={available} selected={[]} label={label} onPick={v => { const next = [...value, v]; onChange(next); if (max && next.length >= max) setOpen(false); }} />
            </PopoverContent>
          </Popover>
        </li>}
      </ul>
      {!chosen.length && empty && <p className="inline-note">{empty}</p>}
      {error ? <p className="field-error">{error}</p> : hint && <p className="field-hint">{hint}</p>}
    </fieldset>
  );
}

/** A person with photo, name and a short line under it (for lists and read-only details). */
export function PersonLine({ name, detail, you, size = 'sm', className }: { name: string; detail?: ReactNode; you?: boolean; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  useLanguage();
  return (
    <span className={cn('person-cell', className)}>
      <Avatar name={name} size={size} />
      <span className="cell-stack"><span className="person-name"><Identity name={name}/>{you && <span className="muted"> {uiText("(you)")}</span>}</span>{detail && <small>{detail}</small>}</span>
    </span>
  );
}
