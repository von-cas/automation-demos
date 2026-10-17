// Email templates: `{{name}}` is HTML-escaped, `{{{name}}}` is inserted as-is (trusted markup only).

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function render(template: string, vars: Record<string, string | number | null | undefined>, opts: { html?: boolean } = {}): string {
  const html = opts.html ?? true;
  return template
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, k: string) => String(vars[k] ?? ''))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
      const v = String(vars[k] ?? '');
      return html ? escapeHtml(v) : v;
    });
}

/** The shared email frame: plain, readable, with the 7-day privacy line every demo email carries. */
export function emailFrame(bodyHtml: string, footer = 'This is an automated demo by Von Castro. Your details are deleted after 7 days.'): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f7f4;font-family:Inter,Arial,sans-serif;color:#1a1816;line-height:1.6">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #c9c5bc;padding:28px">${bodyHtml}
<p style="margin-top:28px;padding-top:14px;border-top:1px solid #c9c5bc;font-size:12px;color:#5c5a54">${escapeHtml(footer)}</p>
</div></body></html>`;
}
