// Telegram alerts to Von. Rule: every failure notifies, including repeats. No dedupe, no suppression.
import type { Env, Fetch } from '../env';

export interface FailureAlert {
  demo: string;
  what: string; // job or step name
  runId?: string;
  error: string;
  attempt?: number;
  maxAttempts?: number;
  deadLetterId?: string;
}

export function formatFailure(a: FailureAlert): string {
  const lines = [`Demo failure: ${a.demo} / ${a.what}`];
  if (a.attempt != null) lines.push(`Attempt ${a.attempt}${a.maxAttempts ? ` of ${a.maxAttempts}` : ''}`);
  if (a.runId) lines.push(`Run ${a.runId}`);
  if (a.deadLetterId) lines.push(`Dead-letter ${a.deadLetterId}`);
  lines.push(a.error.slice(0, 600));
  return lines.join('\n');
}

/** Sends a Telegram message. Returns false (and logs) when it cannot; never throws. */
export async function sendTelegram(env: Env, text: string, fetchFn: Fetch = fetch): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error('telegram not configured; alert not sent:', text.slice(0, 200));
    return false;
  }
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('telegram send failed', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('telegram send error', err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function alertFailure(env: Env, alert: FailureAlert, fetchFn: Fetch = fetch): Promise<boolean> {
  return sendTelegram(env, formatFailure(alert), fetchFn);
}
