import { uiText } from "./i18n";
// Server calls for Groups (V5.4, V5.5): one change at a time through /api/command, and reads that never change anything.
import { apiFetch } from './api-client';
import type { Row } from './components';

export type GroupError = Error & { status?: number; details?: Row };

const failed = (res: Response, body: Row, fallback: string) => {
  if (res.status === 401) window.dispatchEvent(new Event('session-expired'));
  return Object.assign(new Error(body.error || fallback), { status: res.status, details: body.details }) as GroupError;
};
async function bodyOf(res: Response): Promise<Row> { try { return await res.json(); } catch { return {}; } }

/** Sends one change to the server. Errors keep the server's details (for example which labels are still in use). */
export async function groupCommand(action: string, data: Row): Promise<Row> {
  const res = await apiFetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, data }) });
  const answer = await bodyOf(res);
  if (!res.ok) throw failed(res, answer, uiText("The change could not be saved. Check your connection and try again."));
  return answer.result || {};
}

/** A read (GET) under /api/tasks/group…, with query parameters. */
export async function groupRead(path: string, params: Record<string, string | number | undefined | null> = {}): Promise<Row> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const res = await apiFetch(`${path}?${q.toString()}`);
  const body = await bodyOf(res);
  if (!res.ok) throw failed(res, body, uiText("This could not be loaded. Check your connection and try again."));
  return body;
}

/** A POST that is not a command (Excel import preview, Google Sheets actions). */
export async function groupPost(path: string, data: Row): Promise<Row> {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = await bodyOf(res);
  if (!res.ok) throw failed(res, body, uiText("This could not be done. Check your connection and try again."));
  return body;
}
