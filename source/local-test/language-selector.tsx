import { useId, useState } from 'react';
import { Languages } from 'lucide-react';
import { LANGUAGES, setLanguage, uiText, useLanguage, type Language } from './i18n';

export function LanguageSelector({ save }: { save: (language: Language) => Promise<unknown> }) {
  const language = useLanguage(), id = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function choose(value: Language) {
    if (value === language || busy) return;
    setBusy(true); setError('');
    try { await save(value); setLanguage(value); }
    catch (e) { setError(e instanceof Error ? e.message : uiText('Language could not be saved. Please try again.')); }
    finally { setBusy(false); }
  }
  return <div className="language-setting" aria-busy={busy}>
    <label htmlFor={id}><Languages size={18} aria-hidden="true" />{uiText('Language')}</label>
    <select id={id} value={language} disabled={busy} onChange={e => void choose(e.target.value as Language)} aria-describedby={`${id}-hint`}>
      {LANGUAGES.map(l => <option key={l.value} value={l.value} lang={l.value}>{l.name}</option>)}
    </select>
    <p id={`${id}-hint`}>{uiText('Applies to the website, Telegram Mini App and your notifications.')}</p>
    {busy && <span role="status">{uiText('Saving…')}</span>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
