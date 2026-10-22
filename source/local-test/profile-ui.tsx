import { uiText, useLanguage } from "./i18n";
import { LanguageSelector } from './language-selector';
import { apiFetch } from './api-client';
import {Identity} from './identity-ui';
import { useState, type FormEvent } from 'react';
import { Camera, Check, CheckCircle2, IdCard, LogOut, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Workspace } from './ui';
import { Alert, Avatar, Field, KeyValues, Picker, useConfirm } from './ui-kit';
import { zoneName, zoneOffset, zoneOptions } from './format';

import { photoFromFile } from './media';
export { fileToBase64, photoFromFile } from './media';

/** Upload / change / remove a profile photo. `save` receives base64 JPEG data; `remove` clears the photo. */
export function PhotoControl({ name, hasPhoto, save, remove, busy, setBusy, onError, you }: { name: string; hasPhoto: boolean; save: (base64: string) => Promise<unknown>; remove: () => Promise<unknown>; busy: boolean; setBusy: (b: boolean) => void; onError: (m: string) => void; you?: boolean }) {
  useLanguage();
  const confirm = useConfirm();
  const pick = async (file: File) => { setBusy(true); onError(''); try { await save(await photoFromFile(file)); } catch (e) { onError((e as Error).message); } finally { setBusy(false); } };
  const clear = async () => {
    if (!(await confirm({ title: you ? uiText("Remove your photo?") : uiText("Remove {p0}’s photo?", { p0: name }), description: uiText("Initials are shown instead."), confirmLabel: uiText("Remove photo"), tone: 'danger' }))) return;
    setBusy(true); onError(''); try { await remove(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="profile-photo">
      <Avatar name={name} size="xl" />
      <div className="stack-sm">
        <p className="text-strong">{uiText("Profile photo")}</p>
        <p className="muted small">{you ? uiText("A clear photo of your face helps colleagues recognise you.") : uiText("Shown next to their name everywhere people are chosen.")} {uiText("It is cropped to a square.")}</p>
        <div className="row">
          <label className={`btn-upload${busy ? " is-busy" : ''}`}><Camera aria-hidden="true" />{busy ? uiText("Saving…") : hasPhoto ? uiText("Change photo") : uiText("Upload photo")}
            <input type="file" accept="image/*" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f); }} />
          </label>
          {hasPhoto && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void clear()}><Trash2 />{uiText("Remove photo")}</Button>}
        </div>
      </div>
    </div>
  );
}

/** V5.6.8: the sidebar colours a person can choose for their own screens ('' or 'blue' is the standard deep blue). */
export const SIDEBAR_THEMES: { id: string; label: string; note?: string }[] = [
  { id: 'blue', get label() { return uiText("Deep blue"); }, get note() { return uiText("Standard"); } }, { id: 'graphite', get label() { return uiText("Graphite"); } }, { id: 'light', get label() { return uiText("Light"); } },
  { id: 'red', get label() { return uiText("Brand red"); } }, { id: 'teal', get label() { return uiText("Deep teal"); } },
];
export const sidebarThemeOf = (value: unknown) => (SIDEBAR_THEMES.some(t => t.id === value) ? String(value) : 'blue');

/** My profile → Appearance: five sidebar colours, each with a small preview. A choice applies at once and is saved; if the
 *  save fails the sidebar goes back to the saved colour. */
function SidebarColour({ w, current, onPreview, onError }: { w: Workspace; current: string; onPreview: (theme: string | null) => void; onError: (message: string) => void }) {
  useLanguage();
  const [saving, setSaving] = useState('');
  const choose = async (id: string) => {
    if (id === current || saving) return;
    onPreview(id); setSaving(id); onError('');
    try { await w.perform('me.profile.save', { sidebar_theme: id === 'blue' ? '' : id }); }
    catch (err) { onError((err as Error).message); }
    finally { onPreview(null); setSaving(''); }
  };
  return (
    <fieldset className="profile-appearance">
      <legend className="text-strong">{uiText("Appearance")}</legend>
      <p className="muted small" id="sidebar-colour-hint">{uiText("Sidebar colour. Only your own screens change.")}</p>
      <div className="sb-choices" role="radiogroup" aria-label={uiText("Sidebar colour")} aria-describedby="sidebar-colour-hint">
        {SIDEBAR_THEMES.map(t => (
          <button key={t.id} type="button" role="radio" aria-checked={current === t.id} className="sb-choice" disabled={!!saving && saving !== t.id} onClick={() => void choose(t.id)}>
            <span className="sb-preview" data-sidebar-theme={t.id} aria-hidden="true">
              <span className="sb-preview-row is-active" /><span className="sb-preview-row" /><span className="sb-preview-row is-short" />
            </span>
            <span className="sb-choice-text"><span>{t.label}</span>{t.note && <small>{t.note}</small>}</span>
            {current === t.id && <Check className="sb-choice-check" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** "My profile" (from the name menu): display name, photo and the Telegram connection, for every signed-in person. */
export function MyProfileDialog({ w, onClose, onTelegram, onTeamProfile, sidebarTheme, onSidebarTheme }: { w: Workspace; onClose: () => void; onTelegram?: () => void; onTeamProfile?: () => void; sidebarTheme?: string; onSidebarTheme?: (theme: string | null) => void }) {
  useLanguage();
  const user = w.data.auth.user, name = w.lookup(w.actor), profile = (w.data.tm_profiles || []).find((p: { staff_id: string }) => p.staff_id === w.actor);
  const hasPhoto = (w.data.staff_photos || []).some((p: { staff_id: string }) => p.staff_id === w.actor);
  const [draft, setDraft] = useState(profile?.nickname || ''), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  // V5.5: your own time zone (empty = the company's). The calendar, meeting times and your reminders follow it.
  const savedZone = profile?.timezone || '', companyZone = w.data.company?.timezone || 'Asia/Phnom_Penh';
  const [zone, setZone] = useState(savedZone), [savingZone, setSavingZone] = useState(false);
  const saveZone = async (e: FormEvent) => {
    e.preventDefault(); if (zone === savedZone) return;
    setSavingZone(true); setError('');
    try { await w.perform('me.profile.save', { timezone: zone }); } catch (err) { setError((err as Error).message); } finally { setSavingZone(false); }
  };
  const tg = w.data.telegram;
  const saveName = async (e: FormEvent) => {
    e.preventDefault(); if (draft.trim() === (profile?.nickname || '')) return;
    setSaving(true); setError('');
    try { await w.perform('me.profile.save', { nickname: draft.trim() }); } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !busy && !saving) onClose(); }}>
      <DialogContent className="dialog-md">
        <DialogHeader>
          <DialogTitle>{uiText("My profile")}</DialogTitle>
          <DialogDescription>{uiText("Your name and photo help colleagues recognise you when they assign or share work, in the Task Controlling Management and in Telegram.")}</DialogDescription>
        </DialogHeader>
        <div className="dialog-body stack">
          {error && <Alert tone="danger" title={uiText("This could not be saved")} live>{error}</Alert>}
          <LanguageSelector save={async language => {
            const response = await apiFetch('/api/me/language', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language }) });
            const result = await response.json(); if (!response.ok) throw new Error(result.error);
            await w.refresh({ quiet: true });
          }} />
          <PhotoControl name={name} hasPhoto={hasPhoto} you busy={busy} setBusy={setBusy} onError={setError}
            save={base64 => w.perform('me.photo.save', { base64 })} remove={() => w.perform('me.photo.remove', {})} />
          <form onSubmit={saveName} className="profile-name" noValidate>
            <Field label={uiText("Username / display name")} value={user.username || user.name} onChange={() => {}} disabled /><Field label={uiText("Nickname (optional)")} value={draft} onChange={setDraft} maxLength={80} disabled={saving}
              hint={uiText("Shown in parentheses next to your username.")} />
            <Button type="submit" size="sm" disabled={saving || draft.trim() === (profile?.nickname || '')} loading={saving}>{uiText("Save nickname")}</Button>
          </form>
          <form onSubmit={saveZone} className="profile-name" noValidate>
            <Picker label={uiText("My time zone")} value={zone} options={zoneOptions()} none={uiText("Company time zone · {p0} ({p1})", { p0: zoneName(companyZone), p1: zoneOffset(companyZone) })} onChange={setZone} disabled={savingZone}
              hint={uiText("Your calendar, meeting times and reminders use it.")} />
            <Button type="submit" size="sm" disabled={savingZone || zone === savedZone} loading={savingZone}>{uiText("Save time zone")}</Button>
          </form>
          {onSidebarTheme && <SidebarColour w={w} current={sidebarThemeOf(sidebarTheme)} onPreview={onSidebarTheme} onError={setError} />}
          <KeyValues dense items={[[uiText("Username"), user.username], [uiText("Role"), user.role_name], [uiText("Department"), profile?.department || null], [uiText("Position"), profile?.position || null], [uiText("Reports to"), profile?.manager_id ? w.lookup(profile.manager_id) : null]]} />
          {onTeamProfile ? <Button type="button" size="sm" variant="ghost" className="self-start" onClick={onTeamProfile}><IdCard />{uiText("Edit department, position and contact details")}</Button>
            : <p className="muted small">{uiText("Your department and position are kept by the people who manage the team list.")}</p>}
          {onTelegram && tg?.enabled && (
            <div className="profile-telegram">
              {tg.link ? <p className="row"><CheckCircle2 aria-hidden="true" className="text-success inline-icon" />{uiText("Telegram is connected")}{tg.link.username ? uiText(" as @{p0}", { p0: tg.link.username }) : ''}.</p> : <p className="muted small">{uiText("Connect Telegram to get your tasks and answer them on your phone.")}</p>}
              <Button type="button" size="sm" variant="outline" onClick={onTelegram}><Send />{tg.link ? uiText("Telegram settings") : uiText("Connect Telegram")}</Button>
            </div>
          )}
          <SignOutEverywhere w={w} />
        </div>
        <div className="dialog-footer"><Button variant="outline" onClick={onClose} disabled={busy || saving}>{uiText("Done")}</Button></div>
      </DialogContent>
    </Dialog>
  );
}

/** V5.6.8: end every Task Controlling Management session of this account (all browsers and devices), for example after using a shared computer. */
function SignOutEverywhere({ w }: { w: Workspace }) {
  useLanguage();
  const confirm = useConfirm(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async () => {
    if (!(await confirm({ title: uiText("Sign out of all devices?"), description: uiText("Every browser where you are signed in to the Task Controlling Management is signed out, including this one. Telegram stays connected; disconnect it in Telegram settings if needed."), confirmLabel: uiText("Sign out everywhere"), tone: 'danger' }))) return;
    setBusy(true); setError('');
    try { await w.perform('me.sessions.end', {}); window.location.reload(); } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <div className="profile-telegram">
      <p className="muted small">{uiText("Signed in on a shared or lost device? End every session of your account.")}</p>
      {error && <Alert tone="danger" title={uiText("This could not be done")} live>{error}</Alert>}
      <Button type="button" size="sm" variant="outline" onClick={() => void run()} loading={busy} disabled={busy}><LogOut />{uiText("Sign out of all devices")}</Button>
    </div>
  );
}
