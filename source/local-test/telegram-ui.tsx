import { uiText, useLanguage, dynamicLabels } from "./i18n";
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Bot, CheckCircle2, Copy, Link2Off, MessageCircle, RefreshCw, Send, Smartphone, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Row } from './components';
import type { Workspace } from './ui';
import { formatDateTime, plural } from './format';
import { qrPath } from './qr.mjs';
import { Alert, ButtonLink, Card, DataTable, DateText, EmptyState, Field, FormSection, KeyValues, PasswordField, Picker, StatusBadge, SwitchField, useConfirm, useFormErrors, type Tone } from './ui-kit';

const STATUS: Record<string, { label: string; tone: Tone }> = { ONLINE: { get label() { return uiText("Online"); }, tone: 'success' }, STARTING: { get label() { return uiText("Connecting…"); }, tone: 'info' }, RECONNECTING: { get label() { return uiText("Reconnecting"); }, tone: 'warning' }, ERROR: { get label() { return uiText("Needs attention"); }, tone: 'danger' }, OFF: { get label() { return uiText("Off"); }, tone: 'neutral' } };
const copy = (text: string, what = 'Copied') => { void navigator.clipboard?.writeText(text).then(() => toast.success(what)).catch(() => toast.error(uiText("Copy failed. Select the text and copy it manually."))); };
const DELIVERY: Record<'SENT' | 'PENDING' | 'SKIPPED' | 'FAILED', { label: string; tone: Tone }> = { SENT: { get label() { return uiText("Sent"); }, tone: 'success' }, PENDING: { get label() { return uiText("Waiting"); }, tone: 'info' }, SKIPPED: { get label() { return uiText("Not sent"); }, tone: 'neutral' }, FAILED: { get label() { return uiText("Failed"); }, tone: 'danger' } };
const HOURS: [string, string][] = [dynamicLabels(['-1', "Off"], { 1: () => uiText("Off") }), ...Array.from({ length: 24 }, (_, h) => [String(h), `${String(h).padStart(2, '0')}:00`] as [string, string])];

/** Administration → Telegram: bot token, Mini App address, connected people and groups. */
export function TelegramAdmin({ w }: { w: Workspace }) {
  useLanguage();
  const admin: Row | undefined = w.data.telegram_admin, s: Row = admin?.settings || {};
  const canEdit = w.can('admin.telegram', 'update'), confirm = useConfirm(), form = useFormErrors();
  const [d, setD] = useState<Row>({ enabled: !!s.enabled, bot_token: '', mini_app_url: s.mini_app_url || '', digest_hour: String(s.digest_hour ?? 8), group_updates: s.group_updates !== false }), [busy, setBusy] = useState(false);
  useEffect(() => { setD({ enabled: !!s.enabled, bot_token: '', mini_app_url: s.mini_app_url || '', digest_hour: String(s.digest_hour ?? 8), group_updates: s.group_updates !== false }); }, [s.version]); // eslint-disable-line react-hooks/exhaustive-deps
  // Refresh while the bot connects so the status updates without a manual reload.
  useEffect(() => { if (!['STARTING', 'RECONNECTING'].includes(s.status)) return; const t = setTimeout(() => void w.refresh({ quiet: true }), 2500); return () => clearTimeout(t); }, [s.status, s.checked_at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!admin) return <EmptyState title={uiText("Telegram settings are not available")} description={uiText("Your role needs View permission for Administration · Telegram connection.")} />;
  const status = STATUS[s.status] || STATUS.OFF, gateway: Row = admin.gateway || {}, shared: string = gateway.shared_url || '';
  const set = (k: string, v: unknown) => { setD(x => ({ ...x, [k]: v })); form.clear(k); };
  form.register({ key: 'bot_token', label: uiText("Bot token"), aliases: ['token', 'botfather'] });
  form.register({ key: 'mini_app_url', label: uiText("Mini App address"), aliases: ["mini app", 'https'] });
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); form.reset();
    try { await w.perform('admin.telegram.save', { enabled: d.enabled, bot_token: d.bot_token || undefined, mini_app_url: d.mini_app_url, digest_hour: Number(d.digest_hour), group_updates: d.group_updates, expected_version: s.version }); setD(x => ({ ...x, bot_token: '' })); }
    catch (err) { form.fail((err as Error).message); } finally { setBusy(false); }
  };
  const removeToken = async () => {
    if (!(await confirm({ title: uiText("Remove the saved bot token?"), description: uiText("The bot stops and nobody can use Telegram until a token is added again. Connected people and groups stay linked."), confirmLabel: uiText("Remove token"), tone: 'danger' }))) return;
    try { await w.perform('admin.telegram.save', { enabled: false, clear_token: true, expected_version: s.version }); } catch (err) { toast.error((err as Error).message); }
  };
  const unlink = async (p: Row) => { if (await confirm({ title: uiText("Disconnect {p0} from Telegram?", { p0: p.name }), description: uiText("They stop receiving task messages and must connect again from their name menu → Connect Telegram."), confirmLabel: uiText("Disconnect"), tone: 'danger' })) void w.perform('admin.telegram.unlink', { staff_id: p.staff_id }).catch(err => toast.error(err.message)); };
  const setGroup = (g: Row, patch: Row) => void w.perform('admin.telegram.group', { chat_id: g.chat_id, workspace_id: g.workspace_id, notify: !!g.notify, expected_version: g.version, ...patch }).catch(err => toast.error(err.message));
  const workspaces: [string, string][] = w.data.tm_workspaces.filter((x: Row) => x.status === 'ACTIVE').map((x: Row) => [x.id, x.name]);
  return (
    <div className="stack telegram-admin">
      <div className="grid-2">
        <Card title={<span className="card-title-icon"><Bot aria-hidden="true" />{uiText("Company bot")}</span>} description={uiText("People use the bot in a private chat or in a linked group. Everything they do is saved in the Task Controlling Management straight away.")}
          actions={<Button size="sm" variant="ghost" onClick={() => void w.refresh()}><RefreshCw />{uiText("Check again")}</Button>}>
          <KeyValues dense items={[
            [uiText("Status"), <span className="row"><StatusBadge value={s.status} label={status.label} tone={status.tone} />{s.status_detail && <span className="muted small">{s.status_detail}</span>}</span>],
            [uiText("Bot"), s.bot_username ? <a href={`https://t.me/${s.bot_username}`} target="_blank" rel="noopener noreferrer">@{s.bot_username}<span className="sr-only"> {uiText("(opens Telegram)")}</span></a> : null],
            [uiText("Token"), s.token_set ? `Saved (${s.token_hint})` : uiText("Not set")],
            [uiText("Last checked"), s.checked_at ? formatDateTime(s.checked_at) : null],
            [uiText("Connected people"), String(admin.links.length)],
            [uiText("Linked groups"), String(admin.groups.filter((g: Row) => g.workspace_id && g.active).length)],
          ]} />
        </Card>
        <Card title={<span className="card-title-icon"><Smartphone aria-hidden="true" />{uiText("Telegram Mini App")}</span>} description={uiText("A task app that opens inside Telegram on phones, using the same data and permissions as the Task Controlling Management.")}>
          {shared && <Alert tone="info" className="mb-3" title={uiText("Shared access")}>{uiText("While the sharing window is open, people use the Task Controlling Management and the Mini App at ")}<span className="mono break-all">{shared}</span>{uiText(". The public address saved below is used again after sharing stops.")}</Alert>}
          <KeyValues dense items={[
            [uiText("Gateway on this computer"), gateway.running ? <span className="mono">{gateway.local_url}</span> : <span className="text-warning">{uiText("Not running")}{gateway.port ? uiText(" (port {p0} may be in use)", { p0: gateway.port }) : ''}</span>],
            [shared ? uiText("Shared address") : uiText("Public address"), shared ? <span className="break-all">{shared}</span> : s.mini_app_url || null],
            [uiText("Mini App link"), s.app_url ? <span className="row"><span className="mono small break-all">{s.app_url}</span><Button size="xs" variant="ghost" onClick={() => copy(s.app_url, uiText("Mini App link copied"))}><Copy />{uiText("Copy")}</Button></span> : null],
          ]} />
          {!s.mini_app_url && !shared && <p className="field-hint mt-3">{uiText("Telegram opens Mini Apps only over HTTPS. Publish the gateway address above with an HTTPS tunnel or your own server, then enter that public address in the settings below.")}</p>}
        </Card>
      </div>
      <Card title={uiText("Settings")} description={uiText("Create the bot with @BotFather in Telegram and paste its token here. The token is stored in this company’s database on this computer and is never shown again.")}>
        <form className="dialog-form" onSubmit={save} noValidate>
          <fieldset disabled={busy || !canEdit}>
            {form.formError && <Alert tone="danger" title={uiText("Settings were not saved")} live>{form.formError}</Alert>}
            {s.status === 'ERROR' && <Alert tone="danger" title={uiText("The bot is not working")}>{s.status_detail}</Alert>}
            <FormSection>
              <SwitchField label={uiText("Telegram is on")} description={uiText("Turn off to stop the bot and the Mini App for this company.")} checked={d.enabled} onChange={v => set('enabled', v)} />
              <p className="field-hint">{uiText("Task notifications go only to the people on each task (person in charge, assigner, reviewer and supporting people), in the Task Controlling Management, in Telegram and in the Mini App. Linked groups can still list and open their workspace’s tasks, but task updates are not posted there.")}</p>
              <PasswordField fieldKey="bot_token" label={s.token_set ? uiText("Replace bot token") : uiText("Bot token")} value={d.bot_token} onChange={v => set('bot_token', v)} autoComplete="off" error={form.errors.bot_token}
                hint={s.token_set ? uiText("A token ending {p0} is saved. Leave empty to keep it.", { p0: s.token_hint }) : uiText("From @BotFather → /newbot, for example 123456789:AA…")} />
              <Field fieldKey="mini_app_url" label={uiText("Mini App public address (HTTPS)")} value={d.mini_app_url} onChange={v => set('mini_app_url', v)} placeholder="https://tasks.example.com" error={form.errors.mini_app_url}
                hint={uiText("The HTTPS address that forwards to {p0} on this computer. Optional: the bot works without it.", { p0: gateway.local_url || 'the gateway' })} />
              <Picker label={uiText("Daily summary in Telegram")} value={d.digest_hour} allowNone={false} options={HOURS} onChange={v => set('digest_hour', v)} hint={uiText("Cambodia time. Each connected person gets overdue, due-today and waiting-for-you items.")} />
            </FormSection>
            {canEdit && <div className="form-actions">
              {s.token_set && <Button type="button" variant="danger-outline" disabled={busy} onClick={() => void removeToken()}>{uiText("Remove token")}</Button>}
              <Button type="submit" loading={busy}>{uiText("Save Telegram settings")}</Button>
            </div>}
          </fieldset>
        </form>
      </Card>
      <Card title={uiText("Set-up steps")} description={uiText("About ten minutes. Nothing is sent to Telegram until the bot is turned on.")}>
        <ol className="setup-steps">
          <li><strong>{uiText("Create the bot.")}</strong> {uiText("In Telegram, open ")}<a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>{uiText(", send ")}<code>/newbot</code>{uiText(", choose a name and a username ending in “bot”, and copy the token.")}</li>
          <li><strong>{uiText("Connect it here.")}</strong> {uiText("Paste the token above, turn Telegram on and save. The status changes to Online within a few seconds while this computer is connected to the internet.")}</li>
          <li><strong>{uiText("People connect their accounts.")}</strong> {uiText("Each person clicks their name (top right) → ")}<em>{uiText("Connect Telegram")}</em>{uiText(", then taps ")}<em>{uiText("Open Telegram")}</em> {uiText("or scans the QR code with their phone. Their personal link does not expire and works once. With the Mini App set up, people can instead open the bot, tap ")}<em>{uiText("Tasks")}</em> {uiText("and sign in with their Task Controlling Management email and password. Either way they use their own Task Controlling Management permissions.")}</li>
          <li><strong>{uiText("Groups (optional).")}</strong> {uiText("Add the bot to a Telegram group, then an administrator or the workspace owner sends ")}<code>/connect</code> {uiText("in the group and picks the workspace. Everyone in that group can see the workspace’s task titles and updates.")}</li>
          <li><strong>{uiText("Mini App (optional).")}</strong> {uiText("Publish ")}<span className="mono">{gateway.local_url || 'http://127.0.0.1:4306'}</span> {uiText("over HTTPS — for example ")}<code>{uiText("cloudflared tunnel --url ")}{gateway.local_url || 'http://127.0.0.1:4306'}</code> {uiText("— and enter the https:// address above. The bot’s menu button then opens the task app. You can also set it as the bot’s Main Mini App in @BotFather.")}</li>
        </ol>
      </Card>
      <Card title={<span className="card-title-icon"><Users aria-hidden="true" />{uiText("Connected people")}</span>} description={uiText("Telegram accounts linked to Task Controlling Management logins. Disabling an Task Controlling Management login blocks its Telegram access at once.")} flush>
        <DataTable dense rows={admin.links} rowKey={r => r.staff_id} stateKey="tg-links" itemName="connected people"
          columns={[
            { key: 'name', header: uiText("Person"), minWidth: 180 },
            { key: 'username', header: uiText("Telegram"), cell: r => r.username ? `@${r.username}` : r.first_name || null },
            { key: 'linked_at', header: uiText("Connected"), cell: r => <DateText value={r.linked_at} /> },
            { key: 'last_seen_at', header: uiText("Last active"), cell: r => r.last_seen_at ? formatDateTime(r.last_seen_at) : null },
            { key: 'notify', header: uiText("Messages"), cell: r => <StatusBadge value={r.notify ? 'ON' : 'OFF'} label={r.notify ? uiText("On") : uiText("Off")} tone={r.notify ? 'success' : 'neutral'} /> },
            { key: 'actions', header: <span className="sr-only">{uiText("Actions")}</span>, sortable: false, align: 'right', cell: r => canEdit ? <Button size="xs" variant="ghost" onClick={e => { e.stopPropagation(); void unlink(r); }}><Link2Off />{uiText("Disconnect")}</Button> : null },
          ]} empty={<EmptyState compact icon={MessageCircle} title={uiText("Nobody has connected Telegram yet")} description={uiText("People connect from their name menu → Connect Telegram once the bot is online.")} />} />
      </Card>
      <Card title={uiText("Groups")} description={uiText("Groups the bot has been added to. Link a group to a workspace so its members can list and open that workspace’s tasks there. Task updates are not posted in groups: notifications go only to the people on each task.")} flush>
        <DataTable dense rows={admin.groups} rowKey={r => r.chat_id} stateKey="tg-groups" itemName="groups"
          columns={[
            { key: 'title', header: uiText("Group"), minWidth: 180, cell: r => <span className="cell-stack"><span className="cell-title">{r.title}</span><small>{r.active ? uiText("Seen {p0}", { p0: formatDateTime(r.seen_at) }) : uiText("The bot was removed from this group")}</small></span> },
            { key: 'workspace', header: uiText("Workspace"), minWidth: 200, cell: r => canEdit ? <Picker label={uiText("Workspace for {p0}", { p0: r.title })} hideLabel value={r.workspace_id || ''} none={uiText("Not linked")} options={workspaces} onChange={v => setGroup(r, { workspace_id: v || null })} /> : r.workspace || null },
          ]} empty={<EmptyState compact icon={Users} title={uiText("No groups yet")} description={uiText("Add the bot to a Telegram group; it appears here.")} />} />
      </Card>
      {admin.deliveries && <Card title={<span className="card-title-icon"><MessageCircle aria-hidden="true" />{uiText("Message delivery")}</span>} description={uiText("Each Telegram message is queued, checked again when it is sent (the person must still be on the task and allowed to see it) and sent once. Last 7 days.")} flush>
        <div className="card-inset delivery-summary">{(['SENT', 'PENDING', 'SKIPPED', 'FAILED'] as const).map(k => { const n = admin.deliveries.summary.find((x: Row) => x.status === k)?.n || 0; return <span key={k} className="delivery-stat"><StatusBadge value={k} label={DELIVERY[k].label} tone={DELIVERY[k].tone} /><strong className="num">{n}</strong></span>; })}</div>
        <DataTable dense rows={admin.deliveries.recent} rowKey={r => `${r.notification_id}`} stateKey="tg-deliveries" itemName="messages"
          columns={[
            { key: 'updated_at', header: uiText("When"), cell: r => <span className="nowrap">{formatDateTime(r.updated_at)}</span> },
            { key: 'name', header: uiText("To"), cell: r => r.name },
            { key: 'kind', header: uiText("About"), cell: r => String(r.kind || '').replaceAll('_', ' ') },
            { key: 'status', header: uiText("Result"), cell: r => <StatusBadge value={r.status} label={DELIVERY[r.status as keyof typeof DELIVERY]?.label || r.status} tone={DELIVERY[r.status as keyof typeof DELIVERY]?.tone || 'neutral'} /> },
            { key: 'reason', header: uiText("Detail"), wrap: true, cell: r => r.reason ? <small>{r.reason}</small> : null },
            { key: 'attempts', header: uiText("Attempts"), numeric: true, cell: r => <span className="num">{r.attempts}</span> },
          ]} empty={<EmptyState compact icon={MessageCircle} title={uiText("No messages in the last 7 days")} />} />
      </Card>}
      {admin.log?.length > 0 && <details className="disclosure"><summary>{uiText("Recent bot activity")}<span className="summary-meta">{admin.log.length} {plural(admin.log.length, 'entry', 'entries')}</span></summary><div className="disclosure-body"><ul className="tg-log">{admin.log.map((l: Row) => <li key={l.id} className={`tg-log-${l.level}`}><span className="mono small">{formatDateTime(l.created_at)}</span> <StatusBadge value={l.level} label={l.level === 'error' ? uiText("Error") : l.level === 'warn' ? uiText("Warning") : uiText("Info")} tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warning' : 'neutral'} /> {l.message}</li>)}</ul></div></details>}
    </div>
  );
}

/** "Connect Telegram" (name menu or My profile): a personal link that does not expire, a QR code for the phone,
 *  the /link command, and signing in inside the Telegram task app with the Task Controlling Management email and password. */
export function TelegramConnectDialog({ w, onClose }: { w: Workspace; onClose: () => void }) {
  useLanguage();
  const tg: Row = w.data.telegram || {}, link: Row | null = tg.link || null;
  const [made, setMade] = useState<Row | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const confirm = useConfirm();
  const current: Row | null = tg.connect || made;
  const make = async (renew: boolean) => {
    setBusy(true); setError('');
    try { setMade(await w.perform('tg.link.code', renew ? { renew: true } : {}, { quiet: !renew })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  // The personal link is made when the dialog first opens and kept until it is used or replaced.
  useEffect(() => { if (tg.enabled && !link && !current && !busy && !error) void make(false); }, [tg.enabled, !!link]); // eslint-disable-line react-hooks/exhaustive-deps
  // While not connected, check every few seconds so the dialog shows the connection as soon as it happens.
  useEffect(() => { if (link || !tg.enabled) return; const t = setInterval(() => { if (document.visibilityState === 'visible') void w.refresh({ quiet: true }); }, 4000); return () => clearInterval(t); }, [!!link, tg.enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const qr = useMemo(() => (current?.link ? qrPath(current.link) : null), [current?.link]);
  const renew = async () => { if (await confirm({ title: uiText("Create a new link?"), description: uiText("Your current link and code stop working. Do this if someone else may have seen them."), confirmLabel: uiText("Create new link") })) void make(true); };
  const disconnect = async () => { if (await confirm({ title: uiText("Disconnect Telegram?"), description: uiText("You stop receiving task messages and can no longer use the bot or the task app until you connect again."), confirmLabel: uiText("Disconnect"), tone: 'danger' })) void w.perform('tg.link.unlink', {}).catch(e => toast.error(e.message)); };
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="dialog-md">
        <DialogHeader>
          <DialogTitle>{link ? uiText("Telegram is connected") : uiText("Connect Telegram")}</DialogTitle>
          <DialogDescription>{uiText("Use Task Management from Telegram: get new tasks, accept or reject them, update progress, submit and close work — all saved in the Task Controlling Management with your permissions.")}</DialogDescription>
        </DialogHeader>
        <div className="dialog-body stack">
          {!tg.enabled ? <Alert tone="neutral" title={uiText("Telegram is not set up for this company")}>{uiText("An administrator can connect the company bot in Administration → Telegram.")}</Alert>
            : link ? <>
              <Alert tone="success" icon={CheckCircle2} title={uiText("Connected{p0}", { p0: link.username ? ` as @${link.username}` : link.first_name ? ` as ${link.first_name}` : '' })}>{uiText("Since ")}{formatDateTime(link.linked_at)}{uiText(". Open ")}<a href={`https://t.me/${tg.bot_username}`} target="_blank" rel="noopener noreferrer">@{tg.bot_username}<span className="sr-only"> {uiText("(opens Telegram)")}</span></a> {uiText("in Telegram and send /menu.")}</Alert>
              <SwitchField label={uiText("Send me task messages in Telegram")} description={uiText("New tasks and requests to accept, reviews, reminders, stuck work and a morning summary.")} checked={!!link.notify} onChange={v => void w.perform('tg.link.notify', { notify: v }).catch(e => toast.error(e.message))} />
              {tg.app_url && <p className="field-hint">{uiText("The task app opens from the “Tasks” button beside the message box in your chat with the bot.")}</p>}
            </> : <>
              {error && <Alert tone="danger" title={uiText("Your link could not be created")} live action={<Button size="sm" variant="outline" onClick={() => void make(false)}>{uiText("Try again")}</Button>}>{error}</Alert>}
              {current ? <>
                <div className="tg-connect">
                  {qr && <figure className="tg-qr">
                    <svg viewBox={`0 0 ${qr.view} ${qr.view}`} role="img" aria-label={uiText("QR code of your personal Telegram link")} shapeRendering="crispEdges"><rect width={qr.view} height={qr.view} fill="#fff" /><path d={qr.d} fill="#111" /></svg>
                    <figcaption>{uiText("Scan with your phone’s camera")}</figcaption>
                  </figure>}
                  <div className="stack-sm">
                    <ol className="setup-steps compact">
                      <li>{uiText("Tap ")}<strong>{uiText("Open Telegram")}</strong>{uiText(", or scan the code with your phone.")}</li>
                      <li>{uiText("Tap ")}<strong>{uiText("Start")}</strong> {uiText("in the chat with @")}{current.bot_username}.</li>
                      <li>{uiText("The bot confirms who you are. That’s it.")}</li>
                    </ol>
                    <div className="row">
                      <ButtonLink href={current.link} target="_blank" rel="noopener noreferrer" variant="default"><Send />{uiText("Open Telegram")}<span className="sr-only"> {uiText("(opens a new window)")}</span></ButtonLink>
                      <Button variant="outline" size="sm" onClick={() => copy(current.link, uiText("Link copied"))}><Copy />{uiText("Copy link")}</Button>
                    </div>
                    <p className="tg-code"><span className="muted small">{uiText("Or send the bot")}</span><code>{uiText("/link ")}{current.code}</code><Button size="xs" variant="ghost" onClick={() => copy(`/link ${current.code}`, uiText("Command copied"))}><Copy />{uiText("Copy")}</Button></p>
                  </div>
                </div>
                <p className="muted small">{uiText("This link is only for you: it connects the Telegram account that opens it to your Task Controlling Management login. It does not expire and works once. If someone else may have seen it, create a new one — the old one then stops working. This window updates when you are connected.")}</p>
              </> : !error && <p className="muted" role="status">{uiText("Preparing your personal link…")}</p>}
              {tg.app_url && <Alert tone="info" icon={Smartphone} title={uiText("Prefer to sign in?")}>{uiText("Open ")}<strong>@{tg.bot_username}</strong> {uiText("in Telegram, tap ")}<strong>{uiText("Tasks")}</strong> {uiText("and sign in with your Task Controlling Management email and password. No link needed.")}</Alert>}
            </>}
        </div>
        <div className="dialog-footer">
          {link && <div className="footer-start"><Button variant="danger-outline" size="sm" onClick={() => void disconnect()}><Link2Off />{uiText("Disconnect")}</Button></div>}
          {tg.enabled && !link && current && <div className="footer-start"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void renew()}><RefreshCw />{uiText("Create a new link")}</Button></div>}
          <Button variant="outline" onClick={onClose}>{link ? uiText("Done") : uiText("Close")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
