import type { RequestHandler } from './$types';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { MEDIA_DIR, photoAccess } from '#lib/server/db.js';
import { isAdmin } from '#lib/server/auth.js';

export const GET: RequestHandler = async ({params,cookies,request}) => {
  const {id,variant} = params;
  if (!/^[0-9a-f-]{36}$/.test(id) || !['large','thumb','video'].includes(variant))
    return new Response('Introuvable', {status:404});
  const row = photoAccess(id);
  if (!row || (!row.published && !isAdmin(cookies))) return new Response('Introuvable', {status:404});
  if (variant === 'video') {
    if (row.kind !== 'video') return new Response('Introuvable', {status:404});
    const path = join(MEDIA_DIR, `${id}.mp4`);
    let size: number;
    try { size = (await stat(path)).size; }
    catch { return new Response('Introuvable', {status:404}); }
    const headers = new Headers({
      'content-type': 'video/mp4', 'accept-ranges': 'bytes',
      'cache-control': row.published ? 'public, max-age=3600' : 'private, no-store',
      'x-content-type-options': 'nosniff'
    });
    let start = 0, end = size - 1, status = 200;
    const range = request.method === 'HEAD' || request.headers.has('if-range') ? null : request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const invalid = () => new Response(null, {status:416, headers: {...Object.fromEntries(headers), 'content-range': `bytes */${size}`}});
      if (!match || (!match[1] && !match[2])) return invalid();
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), end) : end;
      } else {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
        start = Math.max(0, size - suffix);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return invalid();
      status = 206;
      headers.set('content-range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('content-length', String(end - start + 1));
    if (request.method === 'HEAD') return new Response(null, {status, headers});
    const stream = createReadStream(path, {start, end});
    const abort = () => stream.destroy();
    request.signal.addEventListener('abort', abort, {once: true});
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {status, headers});
  }
  const filename = variant === 'thumb' ? `${id}_sm.webp` : `${id}.webp`;
  try {
    const contents = await readFile(join(MEDIA_DIR, filename));
    return new Response(new Uint8Array(contents), {
      headers: {
        'content-type':'image/webp',
        'cache-control':row.published ? 'public, max-age=3600' : 'private, no-store',
        'x-content-type-options':'nosniff'
      }
    });
  } catch { return new Response('Introuvable', {status:404}); }
};

export const HEAD = GET;
