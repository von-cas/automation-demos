// Gmail + Google Calendar client for the demo account, using an OAuth refresh token.
// Scopes the consent must grant: gmail.send, gmail.modify (read a label, mark processed),
// calendar.events and calendar.freebusy.
import type { Env, Fetch } from '../env';

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function clearTokenCache(): void {
  tokenCache.clear();
}

// ---------- MIME ----------

const enc = new TextEncoder();

export function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Url(input: string | Uint8Array): string {
  const b = base64(typeof input === 'string' ? enc.encode(input) : input);
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64(enc.encode(value))}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

function assertHeaderSafe(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new GoogleError(`Header injection blocked in ${field}`, 400);
}

export interface Attachment {
  filename: string;
  mimeType: string; // e.g. text/calendar; method=REQUEST
  content: string | Uint8Array;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: Attachment[];
}

export function buildMime(from: { name: string; address: string }, msg: EmailMessage, boundarySeed = crypto.randomUUID()): string {
  for (const [k, v] of [['to', msg.to], ['subject', msg.subject], ['replyTo', msg.replyTo ?? '']] as const) assertHeaderSafe(v, k);
  const alt = `alt-${boundarySeed}`;
  const mixed = `mix-${boundarySeed}`;
  const headers = [
    `From: "${encodeHeader(from.name).replace(/"/g, '')}" <${from.address}>`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (msg.replyTo) headers.push(`Reply-To: ${msg.replyTo}`);

  const altPart = [
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64(enc.encode(msg.text))),
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64(enc.encode(msg.html))),
    `--${alt}--`,
  ].join('\r\n');

  if (!msg.attachments?.length) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, '', altPart, ''].join('\r\n');
  }
  const parts = [`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '', altPart];
  for (const a of msg.attachments) {
    assertHeaderSafe(a.filename, 'filename');
    const bytes = typeof a.content === 'string' ? enc.encode(a.content) : a.content;
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.mimeType}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(base64(bytes)),
    );
  }
  parts.push(`--${mixed}--`);
  return [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', parts.join('\r\n'), ''].join('\r\n');
}

// ---------- client ----------

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  attachments: { attachmentId: string; filename: string; mimeType: string; size: number }[];
}

export interface BusyInterval {
  start: string;
  end: string;
}

export interface CreatedEvent {
  id: string;
  htmlLink: string;
  meetLink: string | null;
}

export class GoogleClient {
  private readonly fetchFn: Fetch;

  constructor(
    private readonly env: Env,
    fetchFn?: Fetch,
  ) {
    this.fetchFn = fetchFn ?? fetch;
  }

  get isConfigured(): boolean {
    return Boolean(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET && this.env.GOOGLE_REFRESH_TOKEN);
  }

  /** Exchanges the refresh token for an access token, cached until a minute before expiry. */
  async accessToken(now = Date.now()): Promise<string> {
    const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_REFRESH_TOKEN: refresh } = this.env;
    if (!id || !secret || !refresh) throw new GoogleError('Google OAuth secrets are not set', 503);
    const cached = tokenCache.get(id);
    if (cached && cached.expiresAt > now + 60_000) return cached.token;
    const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // invalid_grant usually means the refresh token expired or was revoked (Testing-mode apps: 7 days).
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new GoogleError(`Token exchange failed: HTTP ${res.status} ${body.error ?? ''}`.trim(), res.status);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    tokenCache.set(id, { token: body.access_token, expiresAt: now + body.expires_in * 1000 });
    return body.access_token;
  }

  private async api<T>(url: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchFn(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new GoogleError(`Google API ${init.method ?? 'GET'} ${new URL(url).pathname} failed: HTTP ${res.status}`, res.status);
    }
    if (res.status === 204 || okStatuses.includes(res.status)) return undefined as T;
    return (await res.json()) as T;
  }

  // ----- Gmail -----

  async sendEmail(msg: EmailMessage): Promise<{ id: string; threadId: string }> {
    const raw = base64Url(buildMime({ name: this.env.GMAIL_FROM_NAME, address: this.env.GMAIL_FROM_ADDRESS }, msg));
    return this.api('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw }),
    });
  }

  /** Messages matching a Gmail search, e.g. `label:invoice -label:processed`. */
  async listMessages(query: string, max = 10): Promise<{ id: string; threadId: string }[]> {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(max));
    const body = await this.api<{ messages?: { id: string; threadId: string }[] }>(url.toString());
    return body.messages ?? [];
  }

  async getMessage(id: string): Promise<GmailMessageSummary> {
    type Part = { filename?: string; mimeType?: string; body?: { attachmentId?: string; size?: number }; parts?: Part[] };
    const m = await this.api<{
      id: string;
      threadId: string;
      snippet: string;
      payload: Part & { headers?: { name: string; value: string }[] };
    }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
    const header = (n: string) => m.payload.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? '';
    const attachments: GmailMessageSummary['attachments'] = [];
    const walk = (p: Part) => {
      if (p.filename && p.body?.attachmentId) {
        attachments.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream', size: p.body.size ?? 0 });
      }
      p.parts?.forEach(walk);
    };
    walk(m.payload);
    return { id: m.id, threadId: m.threadId, subject: header('subject'), from: header('from'), date: header('date'), snippet: m.snippet, attachments };
  }

  /** Attachment bytes as standard base64 (ready for Gemini inlineData). */
  async getAttachment(messageId: string, attachmentId: string): Promise<string> {
    const body = await this.api<{ data: string }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return base64(base64UrlDecode(body.data));
  }

  async labelId(name: string, create = true): Promise<string> {
    const body = await this.api<{ labels: { id: string; name: string }[] }>('https://gmail.googleapis.com/gmail/v1/users/me/labels');
    const found = body.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    if (!create) throw new GoogleError(`Gmail label ${name} not found`, 404);
    const made = await this.api<{ id: string }>('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      method: 'POST',
      body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    });
    return made.id;
  }

  async modifyLabels(messageId: string, add: string[], remove: string[] = []): Promise<void> {
    await this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
    });
  }

  // ----- Calendar -----

  async freeBusy(timeMin: string, timeMax: string, calendarId = this.env.DEMO_CALENDAR_ID): Promise<BusyInterval[]> {
    const body = await this.api<{ calendars: Record<string, { busy: BusyInterval[] }> }>('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      body: JSON.stringify({ timeMin, timeMax, timeZone: this.env.DEMO_TIMEZONE, items: [{ id: calendarId }] }),
    });
    return body.calendars[calendarId]?.busy ?? [];
  }

  async createEvent(ev: {
    summary: string;
    description?: string;
    start: string; // RFC 3339
    end: string;
    attendees?: string[];
    meet?: boolean;
    notify?: boolean;
  }): Promise<CreatedEvent> {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.env.DEMO_CALENDAR_ID)}/events`);
    url.searchParams.set('sendUpdates', ev.notify ? 'all' : 'none');
    if (ev.meet) url.searchParams.set('conferenceDataVersion', '1');
    const body: Record<string, unknown> = {
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: ev.start, timeZone: this.env.DEMO_TIMEZONE },
      end: { dateTime: ev.end, timeZone: this.env.DEMO_TIMEZONE },
      attendees: (ev.attendees ?? []).map((email) => ({ email })),
    };
    if (ev.meet) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    const made = await this.api<{
      id: string;
      htmlLink: string;
      hangoutLink?: string;
      conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] };
    }>(url.toString(), { method: 'POST', body: JSON.stringify(body) });
    const meet = made.hangoutLink ?? made.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? null;
    return { id: made.id, htmlLink: made.htmlLink, meetLink: meet };
  }

  /** Cancels an event. An event that is already gone (404/410) counts as cancelled. */
  async cancelEvent(eventId: string, notify = false): Promise<void> {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.env.DEMO_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
    );
    url.searchParams.set('sendUpdates', notify ? 'all' : 'none');
    await this.api(url.toString(), { method: 'DELETE' }, [404, 410]);
  }
}

/** Creates a calendar event and records it so the 7-day purge cancels it. */
export async function createDemoEvent(env: Env, client: GoogleClient, demo: string, ev: Parameters<GoogleClient['createEvent']>[0]) {
  const made = await client.createEvent(ev);
  await env.DB.prepare('INSERT INTO calendar_events (event_id, demo, created_at) VALUES (?, ?, ?)').bind(made.id, demo, Date.now()).run();
  return made;
}
