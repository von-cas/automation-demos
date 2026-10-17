import { beforeEach, describe, expect, it } from 'vitest';
import { GoogleClient, base64UrlDecode, buildMime, clearTokenCache, createDemoEvent, encodeHeader } from '../src/core/google';
import { render, escapeHtml } from '../src/core/templates';
import { env, fakeFetch, jsonResponse, withEnv } from './helpers';

const g = withEnv({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_REFRESH_TOKEN: 'rtoken', GMAIL_FROM_NAME: 'Von Castro — Automation Demo' });
const token = ['oauth2.googleapis.com/token', () => jsonResponse({ access_token: 'at-1', expires_in: 3600 })] as const;

beforeEach(() => clearTokenCache());

describe('MIME', () => {
  it('encodes a non-ASCII display name and subject', () => {
    expect(encodeHeader('plain')).toBe('plain');
    expect(encodeHeader('Von — Demo')).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    const mime = buildMime({ name: 'Von — Demo', address: 'demo@example.com' }, { to: 'a@example.com', subject: 'Hi ✓', html: '<p>x</p>', text: 'x' }, 'seed');
    expect(mime).toContain('From: "=?UTF-8?B?');
    expect(mime).toContain('<demo@example.com>');
    expect(mime).toContain('multipart/alternative; boundary="alt-seed"');
  });

  it('adds attachments in a multipart/mixed body', () => {
    const mime = buildMime(
      { name: 'Demo', address: 'demo@example.com' },
      { to: 'a@example.com', subject: 's', html: 'h', text: 't', attachments: [{ filename: 'invite.ics', mimeType: 'text/calendar; method=REQUEST', content: 'BEGIN:VCALENDAR' }] },
      'seed',
    );
    expect(mime).toContain('multipart/mixed; boundary="mix-seed"');
    expect(mime).toContain('filename="invite.ics"');
    expect(mime).toContain(btoa('BEGIN:VCALENDAR'));
  });

  it('blocks header injection', () => {
    expect(() => buildMime({ name: 'D', address: 'd@example.com' }, { to: 'a@example.com\r\nBcc: x@example.com', subject: 's', html: 'h', text: 't' })).toThrow(/injection/);
  });
});

describe('templates', () => {
  it('escapes {{var}} and keeps {{{raw}}}', () => {
    expect(render('<p>{{name}}</p>{{{link}}}', { name: '<b>Al</b>', link: '<a href="x">x</a>' })).toBe('<p>&lt;b&gt;Al&lt;/b&gt;</p><a href="x">x</a>');
    expect(render('Hi {{name}}', { name: '<Al>' }, { html: false })).toBe('Hi <Al>');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });
});

describe('GoogleClient', () => {
  it('reports missing secrets instead of calling Google', async () => {
    const c = new GoogleClient(env, fakeFetch([]).fetch);
    expect(c.isConfigured).toBe(false);
    await expect(c.accessToken()).rejects.toThrow(/not set/);
  });

  it('exchanges the refresh token once and caches the access token', async () => {
    const f = fakeFetch([[...token]]);
    const c = new GoogleClient(g, f.fetch);
    expect(await c.accessToken(1000)).toBe('at-1');
    expect(await c.accessToken(2000)).toBe('at-1');
    expect(f.calls).toHaveLength(1);
    const form = new URLSearchParams(f.calls[0]!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rtoken');
  });

  it('explains invalid_grant (expired or revoked refresh token)', async () => {
    const f = fakeFetch([['oauth2.googleapis.com/token', () => jsonResponse({ error: 'invalid_grant' }, 400)]]);
    await expect(new GoogleClient(g, f.fetch).accessToken()).rejects.toThrow(/invalid_grant/);
  });

  it('sends mail as base64url raw MIME with the display name', async () => {
    const f = fakeFetch([[...token], ['messages/send', () => jsonResponse({ id: 'm1', threadId: 't1' })]]);
    const r = await new GoogleClient(g, f.fetch).sendEmail({ to: 'lead@example.com', subject: 'Thanks', html: '<p>Hi</p>', text: 'Hi' });
    expect(r.id).toBe('m1');
    const send = f.calls[1]!;
    expect(send.headers.authorization).toBe('Bearer at-1');
    const raw = new TextDecoder().decode(base64UrlDecode(JSON.parse(send.body).raw));
    expect(raw).toContain('To: lead@example.com');
    expect(raw).toContain('<vibecoder866@gmail.com>');
  });

  it('reads a label search and finds attachments in nested parts', async () => {
    const f = fakeFetch([
      [...token],
      [/messages\?/, () => jsonResponse({ messages: [{ id: 'm1', threadId: 't1' }] })],
      [
        'messages/m1?format=full',
        () =>
          jsonResponse({
            id: 'm1',
            threadId: 't1',
            snippet: 'see attached',
            payload: {
              headers: [{ name: 'Subject', value: 'invoice 42' }, { name: 'From', value: 'a@example.com' }],
              parts: [{ mimeType: 'multipart/mixed', parts: [{ filename: 'inv.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att1', size: 10 } }] }],
            },
          }),
      ],
      ['attachments/att1', () => jsonResponse({ data: 'JVBERi0' })],
    ]);
    const c = new GoogleClient(g, f.fetch);
    const list = await c.listMessages('label:invoice -label:processed');
    expect(new URL(f.calls[1]!.url).searchParams.get('q')).toBe('label:invoice -label:processed');
    const m = await c.getMessage(list[0]!.id);
    expect(m.subject).toBe('invoice 42');
    expect(m.attachments).toEqual([{ attachmentId: 'att1', filename: 'inv.pdf', mimeType: 'application/pdf', size: 10 }]);
    expect(await c.getAttachment('m1', 'att1')).toBe('JVBERi0=');
  });

  it('finds or creates a label and modifies labels', async () => {
    const f = fakeFetch([
      [...token],
      ['/labels', (call) => (call.method === 'POST' ? jsonResponse({ id: 'L9' }) : jsonResponse({ labels: [{ id: 'L1', name: 'invoice' }] }))],
      ['/modify', () => jsonResponse({})],
    ]);
    const c = new GoogleClient(g, f.fetch);
    expect(await c.labelId('Invoice')).toBe('L1');
    expect(await c.labelId('processed')).toBe('L9');
    await c.modifyLabels('m1', ['L9'], ['L1']);
    expect(JSON.parse(f.calls.at(-1)!.body)).toEqual({ addLabelIds: ['L9'], removeLabelIds: ['L1'] });
  });

  it('looks up free/busy for the demo calendar', async () => {
    const f = fakeFetch([[...token], ['freeBusy', () => jsonResponse({ calendars: { primary: { busy: [{ start: 'a', end: 'b' }] } } })]]);
    expect(await new GoogleClient(g, f.fetch).freeBusy('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z')).toEqual([{ start: 'a', end: 'b' }]);
    expect(JSON.parse(f.calls[1]!.body).timeZone).toBe('Asia/Manila');
  });

  it('creates an event with a Meet link, records it for the purge, and cancels it', async () => {
    const f = fakeFetch([
      [...token],
      [/\/events\?/, () => jsonResponse({ id: 'ev1', htmlLink: 'https://calendar.google.com/x', hangoutLink: 'https://meet.google.com/abc' })],
      [/\/events\/ev1/, () => new Response(null, { status: 204 })],
    ]);
    const c = new GoogleClient(g, f.fetch);
    const ev = await createDemoEvent(g, c, 'booking', { summary: 'Demo call', start: '2026-10-20T10:00:00+08:00', end: '2026-10-20T10:30:00+08:00', attendees: ['v@example.com'], meet: true });
    expect(ev).toEqual({ id: 'ev1', htmlLink: 'https://calendar.google.com/x', meetLink: 'https://meet.google.com/abc' });
    const create = f.calls[1]!;
    expect(new URL(create.url).searchParams.get('conferenceDataVersion')).toBe('1');
    expect(JSON.parse(create.body).conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet');
    const row = await env.DB.prepare('SELECT demo FROM calendar_events WHERE event_id = ?').bind('ev1').first();
    expect(row).toEqual({ demo: 'booking' });
    await c.cancelEvent('ev1');
    expect(f.calls.at(-1)!.method).toBe('DELETE');
  });

  it('treats an already-deleted event as cancelled', async () => {
    const f = fakeFetch([[...token], [/\/events\/gone/, () => new Response('', { status: 410 })]]);
    await expect(new GoogleClient(g, f.fetch).cancelEvent('gone')).resolves.toBeUndefined();
  });
});
