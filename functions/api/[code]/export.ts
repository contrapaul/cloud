import { HttpError, doCall, readJson, readToken, validCode } from '../_lib';

/* The export, as CSV or JSON.

   POST rather than GET, and the token travels in the body rather than the
   query string, because the host token is the one secret in the system and a
   query string ends up in browser history, in logs, and on screen whenever
   this gets demonstrated on a projector. The client turns the response into a
   download itself. */
export const onRequestPost = async (context: any) => {
  const code = String(context.params.code || '').toUpperCase();
  if (!validCode(code)) throw new HttpError(404, 'No cloud with that code.');

  const body = await readJson(context.request);
  const token = readToken(context.request, body);

  const res = await doCall(context.env, code, 'results', token, {});
  if (!res.ok) return res;
  const data: any = await res.json();

  if (body.format !== 'csv') {
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename(data.title, code, 'json')}"`,
      },
    });
  }

  const rows = [['idea', 'supporters', 'added_at']];
  for (const r of data.results) {
    rows.push([r.text, String(r.supporters), new Date(r.addedAt).toISOString()]);
  }

  return new Response(rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename(data.title, code, 'csv')}"`,
    },
  });
};

/* Quote everything. A hobby with a comma in it is not unusual, and a leading
   =, +, - or @ is what spreadsheet software treats as a formula, so a prefixed
   apostrophe keeps a typed answer from being executed on open. */
function csvCell(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${risky.replace(/"/g, '""')}"`;
}

function filename(title: string, code: string, ext: string): string {
  const stem = String(title || 'cloud')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'cloud';
  return `${stem}-${code}.${ext}`;
}
