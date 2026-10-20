import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { unflatten } from 'devalue';
import { photo } from './fixtures.mjs';

// Exercise real form actions and generated media against an isolated database.
let directory, server, database, origin, cookie;
let logs = '';

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'seretiny-import-'));
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  await startServer();
  const response = await post('/admin/login', { password: 'test-import-password' }, [], false);
  assert.equal(response.status, 303, await response.text());
  cookie = response.headers.get('set-cookie').split(';')[0];
  // Admin load initializes the database even when the public journal is empty.
  assert.equal((await fetch(`${origin}/admin?view=imports`, {headers: {cookie}})).status, 200);
  database = new Database(join(directory, 'seretiny.sqlite'));
  database.prepare('UPDATE chapters SET start_date=? WHERE id=?').run('2024-01-01', 1);
  database.prepare('UPDATE chapters SET start_date=? WHERE id=?').run('2024-11-01', 2);
  const legacyDay = database.prepare("INSERT INTO days (date,title_fr) VALUES ('2020-01-02','Avant la mise à jour')").run().lastInsertRowid;
  database.prepare("INSERT INTO photos (id,day_id,caption_fr,original_name) VALUES ('legacy-photo',?,'Légende existante','legacy.jpg')").run(legacyDay);
  await writeFile(join(directory, 'originals', 'legacy-photo.jpeg'), (await photo('legacy.jpg', '2020:01:02 10:00:00')).buffer);
});

async function startServer() {
  const port = new URL(origin).port;
  server = spawn(process.execPath, ['--import', './tests/google-photos-mock.mjs', 'build/index.js'], {
    cwd: resolve('.'), windowsHide: true,
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin,
      DATA_DIR: directory, ADMIN_PASSWORD: 'test-import-password', SESSION_SECRET: 'test-secret-for-isolated-import-tests-only',
      BODY_SIZE_LIMIT: '120M', PROTOCOL_HEADER: 'x-forwarded-proto',
      GOOGLE_PHOTOS_CLIENT_ID: 'test-client', GOOGLE_PHOTOS_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_PHOTOS_REDIRECT_URI: `${origin}/admin/google-photos/callback`, GOOGLE_PHOTOS_TIME_ZONE: 'Europe/Paris' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => logs += chunk);
  server.stderr.on('data', chunk => logs += chunk);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${origin}/admin/login`)).ok) break;
    } catch {}
    if (attempt === 99 || server.exitCode !== null) throw new Error(`Server failed to start: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

after(async () => {
  if (logs.includes('Error')) process.stderr.write(logs.slice(-6000));
  database?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  if (directory && resolve(directory).startsWith(resolve(tmpdir()) + '\\seretiny-import-')) {
    await rm(directory, { recursive: true, force: true });
  } else if (directory && resolve(directory).startsWith(resolve(tmpdir()) + '/seretiny-import-')) {
    await rm(directory, { recursive: true, force: true });
  }
});

function post(path, fields = {}, photos = [], authenticated = true) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
  for (const item of photos) body.append('photos', new Blob([item.buffer], {type: item.type}), item.name);
  return fetch(`${origin}${path}`, {
    method: 'POST', body, redirect: 'manual',
    headers: {origin, accept: 'text/html', 'x-forwarded-proto': 'http', ...(authenticated && cookie ? {cookie} : {})}
  });
}

function day(date) {
  return database.prepare(`SELECT d.*, c.id AS chapter_id FROM days d LEFT JOIN chapters c ON c.id =
    (SELECT id FROM chapters WHERE start_date <= d.date ORDER BY start_date DESC LIMIT 1) WHERE d.date=?`).get(date);
}

function photoCount(dayId) {
  return database.prepare('SELECT COUNT(*) AS n FROM photos WHERE day_id=?').get(dayId).n;
}

test('automatic import requires authentication', async () => {
  const response = await post('/admin?/importPhotos', {}, [await photo('private.jpg', '2024:05:10 12:00:00')], false);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/admin/login');
  assert.equal(day('2024-05-10'), undefined);
});

test('additive migration indexes existing originals and preserves their captions', async () => {
  assert.ok(database.prepare("SELECT name FROM schema_migrations WHERE name='001-photo-sources'").get());
  const response = await post('/admin?/importPhotos', {}, [await photo('legacy.jpg', '2020:01:02 10:00:00')]);
  assert.equal(response.status, 303);
  assert.match(new URL(response.headers.get('location'), origin).searchParams.get('notice'), /1 doublon/);
  assert.equal(database.prepare("SELECT caption_fr FROM photos WHERE id='legacy-photo'").get().caption_fr, 'Légende existante');
  assert.equal(photoCount(day('2020-01-02').id), 1);
  assert.equal(database.prepare("SELECT taken_at FROM photos WHERE id='legacy-photo'").get().taken_at, '2020-01-02T10:00:00.000');
});

test('taken-date migration recovers existing originals before displaying them', async () => {
  const exited = once(server, 'exit');
  server.kill();
  await exited;
  database.exec(`ALTER TABLE photos DROP COLUMN taken_at;
    DELETE FROM schema_migrations WHERE name='003-photo-taken-at';`);
  await startServer();
  assert.equal((await fetch(`${origin}/`, {headers: {cookie}})).status, 200);
  assert.ok(database.prepare("SELECT name FROM schema_migrations WHERE name='003-photo-taken-at'").get());
  const legacy = database.prepare("SELECT * FROM photos WHERE id='legacy-photo'").get();
  assert.equal(legacy.taken_at, '2020-01-02T10:00:00.000');
  assert.equal(legacy.caption_fr, 'Légende existante');
  assert.equal(day('2020-01-02').published, 0);
});

test('groups capture dates into visible days, preserving the camera day near midnight', async () => {
  const response = await post('/admin?/importPhotos', {chapter: 1}, [
    await photo('morning.jpg', '2024:06:01 08:10:00'),
    await photo('midnight.jpg', '2024:06:02 00:15:00', {OffsetTimeOriginal: '+12:00'}),
    await photo('evening.webp', '2024:06:01 23:50:00', {OffsetTimeOriginal: '-11:00'}, 'webp')
  ]);
  assert.equal(response.status, 303, (await response.text()).slice(0,300));
  assert.match(new URL(response.headers.get('location'), origin).searchParams.get('notice'), /3 photo.*2 journée.*2 nouvelle/);
  assert.equal(photoCount(day('2024-06-01').id), 2);
  assert.equal(photoCount(day('2024-06-02').id), 1);
  assert.equal(day('2024-06-01').published, 1);
  assert.equal(day('2024-06-01').chapter_id, 1);
  const media = database.prepare('SELECT id FROM photos WHERE original_name=?').get('morning.jpg');
  assert.equal((await fetch(`${origin}/media/${media.id}/thumb`)).status, 200);
  assert.equal((await fetch(`${origin}/media/${media.id}/thumb`, {headers: {cookie}})).status, 200);
  assert.equal((await readdir(join(directory, 'originals'))).length, 4);
});

test('reuses existing days and appends photos without overwriting editorial changes', async () => {
  const existing = day('2024-06-01');
  database.prepare("UPDATE days SET title_fr='Le plancher', body_fr='Notre récit', published=1 WHERE id=?").run(existing.id);
  database.prepare('UPDATE photos SET sort_order=12 WHERE day_id=?').run(existing.id);
  const response = await post('/admin?/importPhotos', {chapter: 2}, [await photo('extra.jpg', '2024:06:01 14:00:00')]);
  assert.equal(response.status, 303);
  assert.deepEqual(day('2024-06-01'), {...existing, title_fr: 'Le plancher', body_fr: 'Notre récit', published: 1});
  const added = database.prepare('SELECT * FROM photos WHERE original_name=?').get('extra.jpg');
  assert.equal(added.sort_order, 13);
  assert.equal((await fetch(`${origin}/media/${added.id}/thumb`)).status, 200);
});

test('skips undated photos, continues the batch and reports only unsuccessful files', async () => {
  const countBefore = (await readdir(join(directory, 'originals'))).length;
  const response = await post('/admin?/importPhotos', {}, [
    await photo('no-date.png', null, {}, 'png'),
    await photo('dated.jpg', '2024:06:03 09:00:00'),
    {name: 'broken.jpg', buffer: Buffer.from('not an image'), type: 'image/jpeg'}
  ]);
  assert.equal(response.status, 303);
  const params = new URL(response.headers.get('location'), origin).searchParams;
  assert.match(params.get('notice'), /1 photo/);
  assert.match(params.get('warning'), /2 photo.*no-date.png.*broken.jpg/);
  assert.equal(photoCount(day('2024-06-03').id), 1);
  assert.equal((await readdir(join(directory, 'originals'))).length, countBefore + 1);
});

test('fallback applies only to photos without a usable capture date', async () => {
  const response = await post('/admin?/importPhotos', {fallback_date: '2024-07-01'}, [
    await photo('fallback.jpg', null),
    await photo('bad-exif.jpg', 'invalid'),
    await photo('keep-date.jpg', '2024:07:02 12:00:00')
  ]);
  assert.equal(response.status, 303);
  assert.equal(photoCount(day('2024-07-01').id), 2);
  assert.equal(photoCount(day('2024-07-02').id), 1);
  assert.match(new URL(response.headers.get('location'), origin).searchParams.get('notice'), /remplacement utilisée pour 2 photo/);
});

test('digitized EXIF date is used when original date is absent', async () => {
  const response = await post('/admin?/importPhotos', {}, [await photo('digitized.jpg', null, {DateTimeDigitized: '2024:08:01 10:00:00'})]);
  assert.equal(response.status, 303);
  assert.equal(photoCount(day('2024-08-01').id), 1);
});

test('validates the fallback date and batch size before writing', async () => {
  const image = await photo('validation.jpg', '2024:09:01 10:00:00');
  const countBefore = database.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
  for (const [fields, images] of [
    [{fallback_date: '2024-02-30'}, [image]],
    [{}, []],
    [{}, Array(9).fill(image)]
  ]) {
    assert.equal((await post('/admin?/importPhotos', fields, images)).status, 400);
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM photos').get().n, countBefore);
});

test('an entirely undated batch writes no empty days or orphan files', async () => {
  const daysBefore = database.prepare('SELECT COUNT(*) AS n FROM days').get().n;
  const filesBefore = await readdir(join(directory, 'originals'));
  const response = await post('/admin?/importPhotos', {}, [await photo('undated.jpg', null)]);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Aucune photo importée/);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM days').get().n, daysBefore);
  assert.deepEqual(await readdir(join(directory, 'originals')), filesBefore);
});

test('manual import and editing the display date still work independently of EXIF', async () => {
  const target = day('2024-06-03');
  const response = await post('/admin?/upload', {day_id: target.id}, [await photo('manual.jpg', '2020:01:01 10:00:00')]);
  assert.equal(response.status, 303);
  const image = database.prepare('SELECT * FROM photos WHERE original_name=?').get('manual.jpg');
  assert.equal(image.day_id, target.id);
  assert.equal(day('2020-01-01'), undefined);
  const moved = await post('/admin?/savePhoto', {id: image.id, return_to: target.id, date: '2024-10-01', caption_fr: 'Une légende', sort_order: 0});
  assert.equal(moved.status, 303);
  const updated = database.prepare('SELECT * FROM photos WHERE id=?').get(image.id);
  assert.equal(updated.day_id, day('2024-10-01').id);
  assert.equal(updated.caption_fr, 'Une légende');
  assert.equal(day('2024-10-01').published, 1);
});

test('identical files are skipped despite renaming or changing the requested day', async () => {
  const image = await photo('morning.jpg', '2024:06:01 08:10:00');
  image.name = 'renamed.jpg';
  const before = database.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
  for (const [path, fields] of [
    ['/admin?/importPhotos', {fallback_date: '2024-12-01'}],
    ['/admin?/upload', {day_id: day('2024-06-03').id}]
  ]) {
    const response = await post(path, fields, [image]);
    assert.equal(response.status, 303);
    assert.match(new URL(response.headers.get('location'), origin).searchParams.get('notice'), /1 doublon/);
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM photos').get().n, before);
  assert.equal(day('2024-12-01'), undefined);
});

async function authorizeGoogle(code) {
  const response = await post('/admin?/switchGooglePhotos');
  assert.equal(response.status, 303, (await response.text()).slice(0,300));
  const url = new URL(response.headers.get('location'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'select_account consent');
  const googleCookie = response.headers.getSetCookie().find(value => value.startsWith('seretiny_google_photos=') && !value.startsWith('seretiny_google_photos=;'));
  cookie = cookie.split('; ').filter(value => !value.startsWith('seretiny_google_photos=')).concat(googleCookie.split(';')[0]).join('; ');
  const query = new URLSearchParams({state: url.searchParams.get('state'), code});
  const callback = await fetch(`${origin}/admin/google-photos/callback?${query}`, {headers: {cookie}, redirect: 'manual'});
  assert.equal(callback.status, 303);
  return {callback, query};
}

async function connectGoogle(code = 'success') {
  const {callback, query} = await authorizeGoogle(code);
  assert.equal(new URL(callback.headers.get('location'), origin).searchParams.has('warning'), false, callback.headers.get('location'));
  return query;
}

async function waitGoogleImport() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/admin/google-photos/status`, {headers: {cookie}});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(result.progress);
    if (result.progress.status !== 'running') return result.progress;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Google import did not complete');
}

async function importGoogle(fields = {}) {
  const response = await post('/admin?/importGooglePhotos', fields);
  assert.equal(response.status, 303, (await response.text()).slice(0, 300));
  assert.match(new URL(response.headers.get('location'), origin).searchParams.get('notice'), /démarré/);
  return waitGoogleImport();
}

test('OAuth callback rejects an invalid state and Google endpoints require admin access', async () => {
  const response = await fetch(`${origin}/admin/google-photos/callback?state=wrong&code=success`, {headers: {cookie}, redirect: 'manual'});
  assert.match(new URL(response.headers.get('location'), origin).searchParams.get('warning'), /invalide ou expirée/);
  assert.equal((await fetch(`${origin}/admin/google-photos/status`)).status, 401);
  assert.equal((await post('/admin?/connectGooglePhotos', {}, [], false)).headers.get('location'), '/admin/login');
});

test('Google selection imports capture dates, falls back to Google date and keeps credentials server-side', async () => {
  const query = await connectGoogle();
  const replay = await fetch(`${origin}/admin/google-photos/callback?${query}`, {headers: {cookie}, redirect: 'manual'});
  assert.match(new URL(replay.headers.get('location'), origin).searchParams.get('warning'), /invalide ou expirée/);
  const status = await fetch(`${origin}/admin/google-photos/status`, {headers: {cookie}});
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await status.json()).ready, true);
  const admin = await (await fetch(`${origin}/admin?view=imports`, {headers: {cookie}})).text();
  assert.match(admin, /https:\/\/photos.google.com\/picker/);
  assert.doesNotMatch(admin, /test-access-token|test-client-secret|googleusercontent.com/);
  const progress = await importGoogle({chapter: 2});
  assert.equal(progress.imported, 2);
  assert.equal(progress.created, 2);
  assert.equal(progress.duplicates, 0);
  assert.equal(photoCount(day('2024-11-01').id), 1);
  assert.equal(photoCount(day('2024-11-03').id), 1);
  assert.equal(day('2024-11-01').published, 1);
  assert.equal(day('2024-11-01').chapter_id, 2);
  assert.equal(database.prepare("SELECT taken_at FROM photos WHERE original_name='google-a.jpg'").get().taken_at, '2024-11-01T23:00:00.000');
  assert.equal(database.prepare("SELECT taken_at FROM photos WHERE original_name='google-b.jpg'").get().taken_at, '2024-11-03T00:30:00.000');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM photo_sources WHERE source='google'").get().n, 2);
});

test('Google persistent IDs prevent repeat downloads even after editing captions and dates', async () => {
  const image = database.prepare("SELECT photo_id AS id FROM photo_sources WHERE source='google' AND source_id='google-a'").get();
  await post('/admin?/savePhoto', {id: image.id, date: '2024-11-05', caption_fr: 'À conserver', sort_order: 3});
  await connectGoogle('repeat');
  const progress = await importGoogle();
  assert.equal(progress.imported, 0);
  assert.equal(progress.duplicates, 2);
  const updated = database.prepare('SELECT * FROM photos WHERE id=?').get(image.id);
  assert.equal(updated.caption_fr, 'À conserver');
  assert.equal(updated.day_id, day('2024-11-05').id);
});

test('Google import recognizes a photo already imported from disk and records its Google ID', async () => {
  const image = await photo('from-local.jpg', '2024:12:01 10:00:00');
  assert.equal((await post('/admin?/importPhotos', {}, [image])).status, 303);
  await connectGoogle('local-duplicate');
  const progress = await importGoogle();
  assert.equal(progress.imported, 0);
  assert.equal(progress.duplicates, 1);
  const source = database.prepare("SELECT photo_id FROM photo_sources WHERE source='google' AND source_id='google-local'").get();
  assert.equal(source.photo_id, database.prepare("SELECT id FROM photos WHERE original_name='from-local.jpg'").get().id);
});

test('partial Google imports can be retried safely and reject non-Google download URLs', async () => {
  await connectGoogle('partial');
  const progress = await importGoogle();
  assert.equal(progress.imported, 1);
  assert.equal(progress.failed, 1);
  assert.match(progress.errors.join(' '), /Adresse de téléchargement Google Photos invalide/);
  const retry = await importGoogle();
  assert.equal(retry.imported, 0);
  assert.equal(retry.duplicates, 1);
  assert.equal(retry.failed, 1);
  await post('/admin?/disconnectGooglePhotos');
});

test('deleting a photo clears duplicate tracking so it can be imported again', async () => {
  const id = database.prepare("SELECT photo_id AS id FROM photo_sources WHERE source='google' AND source_id='google-local'").get().id;
  assert.equal((await post('/admin?/deletePhoto', {id})).status, 303);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM photo_sources WHERE photo_id=?').get(id).n, 0);
  await connectGoogle('local-duplicate');
  const progress = await importGoogle();
  assert.equal(progress.imported, 1);
  assert.equal(progress.duplicates, 0);
});

test('OAuth uses the official secondary endpoint when the primary connection times out', async () => {
  await connectGoogle('fallback');
  const status = await fetch(`${origin}/admin/google-photos/status`, {headers: {cookie}});
  assert.equal(status.status, 200);
  assert.equal((await status.json()).ready, true);
  await post('/admin?/disconnectGooglePhotos');
});

test('OAuth connection and certificate failures have useful messages without exposing request details', async () => {
  for (const [scenario, expected] of [
    ['both-unreachable', /Connexion OAuth.*délai de connexion/],
    ['tls-failure', /certificat TLS/],
    ['picker-unreachable', /Sélection Google Photos.*DNS/],
    ['oauth-rejected', /Vérifie la configuration OAuth/]
  ]) {
    const {callback} = await authorizeGoogle(scenario);
    const warning = new URL(callback.headers.get('location'), origin).searchParams.get('warning');
    assert.match(warning, expected);
    assert.doesNotMatch(warning, /secret-request-details|test-client-secret|fetch failed/);
  }
});

test('large selections import in the background across pages with progress and a single active import', async () => {
  await connectGoogle('large-selection');
  const response = await post('/admin?/importGooglePhotos');
  assert.equal(response.status, 303);
  const status = await fetch(`${origin}/admin/google-photos/status`, {headers: {cookie}});
  const current = await status.json();
  assert.equal(current.progress.status, 'running');
  assert.ok(current.progress.processed < 105);
  const admin = await (await fetch(`${origin}/admin?view=imports`, {headers: {cookie}})).text();
  assert.match(admin, /Import en cours/);
  assert.doesNotMatch(admin, /test-access-token|googleusercontent.com/);
  assert.equal((await post('/admin?/importGooglePhotos')).status, 400);
  assert.equal((await post('/admin?/disconnectGooglePhotos')).status, 400);
  const progress = await waitGoogleImport();
  assert.equal(progress.status, 'done');
  assert.equal(progress.total, 105);
  assert.equal(progress.processed, 105);
  assert.equal(progress.imported, 105);
  assert.equal(progress.failed, 0);
  assert.equal(photoCount(day('2025-01-01').id), 105);
  const finished = await (await fetch(`${origin}/admin?view=imports`, {headers: {cookie}})).text();
  assert.match(finished, /Import terminé/);
});

test('all 2000 selected Google items are visited, including pages beyond the old pagination cap', async () => {
  const photoId = database.prepare("SELECT id FROM photos WHERE original_name='google-a.jpg'").get().id;
  const remember = database.prepare("INSERT INTO photo_sources (source,source_id,photo_id) VALUES ('google',?,?)");
  database.transaction(() => {
    for (let i = 0; i < 2000; i++) remember.run(`full-selection-${i}`, photoId);
  })();
  await connectGoogle('full-selection');
  const progress = await importGoogle();
  assert.equal(progress.status, 'done');
  assert.equal(progress.total, 2000);
  assert.equal(progress.processed, 2000);
  assert.equal(progress.duplicates, 2000);
  assert.equal(progress.imported, 0);
});

test('a repeated pagination token stops the import with an actionable error', async () => {
  await connectGoogle('page-cycle');
  const progress = await importGoogle();
  assert.equal(progress.status, 'failed');
  assert.match(progress.message, /page répétée/);
  assert.equal(progress.imported, 0);
  await post('/admin?/disconnectGooglePhotos');
});

test('timeouts while reading photo bytes are retried without saving partial files or duplicates', async () => {
  const before = (await readdir(join(directory, 'originals'))).length;
  await connectGoogle('stream-timeout');
  const progress = await importGoogle();
  assert.equal(progress.imported, 1);
  assert.equal(progress.failed, 0);
  assert.equal(progress.processed, 1);
  assert.equal((await readdir(join(directory, 'originals'))).length, before + 1);
});

test('persistent download timeouts are reported in French and the next photo is imported', async () => {
  const before = (await readdir(join(directory, 'originals'))).length;
  await connectGoogle('stream-permanent');
  const progress = await importGoogle();
  assert.equal(progress.status, 'done');
  assert.equal(progress.imported, 1);
  assert.equal(progress.failed, 1);
  assert.equal(progress.processed, 2);
  assert.match(progress.errors.join(' '), /Téléchargement de la photo.*délai/);
  assert.doesNotMatch(progress.errors.join(' '), /The operation was aborted|test-access-token|googleusercontent/);
  assert.equal((await readdir(join(directory, 'originals'))).length, before + 1);
  await post('/admin?/disconnectGooglePhotos');
});

test('timeouts before response headers and during metadata reading are retried', async () => {
  for (const scenario of ['connection-timeout', 'metadata-timeout']) {
    await connectGoogle(scenario);
    const progress = await importGoogle();
    assert.equal(progress.status, 'done');
    assert.equal(progress.imported, 1);
    assert.equal(progress.failed, 0);
  }
});

test('oversized downloads keep the size limit and are not retried', async () => {
  await connectGoogle('oversize');
  const progress = await importGoogle();
  assert.equal(progress.imported, 0);
  assert.equal(progress.failed, 1);
  assert.match(progress.errors.join(' '), /12 Mo/);
  await post('/admin?/disconnectGooglePhotos');
});

test('refreshing the admin and selecting more photos reuse Google access after an import', async () => {
  await connectGoogle('persistent');
  await importGoogle();
  for (let i = 0; i < 2; i++) {
    const admin = await (await fetch(`${origin}/admin?view=imports`, {headers: {cookie}})).text();
    assert.match(admin, /Compte Google connecté/);
    assert.doesNotMatch(admin, /test-access-token|test-refresh-token|test-client-secret/);
  }
  const response = await post('/admin?/connectGooglePhotos');
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location'), origin).origin, origin);
  const status = await fetch(`${origin}/admin/google-photos/status`, {headers: {cookie}});
  assert.equal(status.status, 200);
  assert.equal((await status.json()).ready, true);
});

test('Google connection and selection survive a full server restart with encrypted credentials', async () => {
  const rows = database.prepare('SELECT * FROM google_connections').all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(rows), /test-access-token|test-refresh-token|test-client-secret|persistent/);
  const exited = once(server, 'exit');
  server.kill();
  await exited;
  await startServer();
  const admin = await (await fetch(`${origin}/admin?view=imports`, {headers: {cookie}})).text();
  assert.match(admin, /Ouvrir Google Photos/);
  assert.doesNotMatch(admin, /test-access-token|test-refresh-token/);
  const response = await post('/admin?/connectGooglePhotos');
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location'), origin).origin, origin);
  await importGoogle();
});

test('access tokens renew automatically without an account chooser', async () => {
  await connectGoogle('short-token');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const responses = await Promise.all([post('/admin?/connectGooglePhotos'), post('/admin?/connectGooglePhotos')]);
  for (const response of responses) {
    assert.equal(response.status, 303, (await response.text()).slice(0,300));
    assert.equal(new URL(response.headers.get('location'), origin).origin, origin);
  }
  const progress = await importGoogle();
  assert.equal(progress.status, 'done');
});

test('revoked refresh tokens request reconnection without looping through Google', async () => {
  await connectGoogle('revoked-token');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const failed = await post('/admin?/connectGooglePhotos');
  assert.equal(failed.status, 400);
  assert.match(await failed.text(), /révoquée/);
  const reconnect = await post('/admin?/connectGooglePhotos');
  const location = new URL(reconnect.headers.get('location'));
  assert.equal(location.origin, 'https://accounts.google.com');
  assert.equal(location.searchParams.get('access_type'), 'offline');
  assert.equal(location.searchParams.get('prompt'), 'consent');
  const nextCookie = reconnect.headers.getSetCookie().find(value => value.startsWith('seretiny_google_photos=') && !value.startsWith('seretiny_google_photos=;'));
  cookie = cookie.split('; ').filter(value => !value.startsWith('seretiny_google_photos=')).concat(nextCookie.split(';')[0]).join('; ');
});

test('Google remains connected across admin logout/login, and explicit Google disconnect forgets saved access', async () => {
  await connectGoogle('persistent-login');
  const loggedOut = await post('/admin?/logout');
  assert.equal(loggedOut.status, 303);
  assert.ok(loggedOut.headers.getSetCookie().every(value => !value.startsWith('seretiny_google_photos=')));
  const googleCookie = cookie.split('; ').find(value => value.startsWith('seretiny_google_photos='));
  assert.equal((await fetch(`${origin}/admin/google-photos/status`, {headers: {cookie: googleCookie}})).status, 401);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const loggedIn = await post('/admin/login', {password: 'test-import-password'}, [], false);
  cookie = `${loggedIn.headers.getSetCookie()[0].split(';')[0]}; ${googleCookie}`;
  const selected = await post('/admin?/connectGooglePhotos');
  assert.equal(new URL(selected.headers.get('location'), origin).origin, origin);
  assert.equal((await post('/admin?/disconnectGooglePhotos')).status, 303);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM google_connections').get().n, 0);
});

async function loadedDays(path = '') {
  const response = await fetch(`${origin}${path}/__data.json`, {headers: {cookie}});
  assert.equal(response.status, 200);
  const result = await response.json();
  return result.nodes.filter(node => node?.type === 'data').map(node => unflatten(node.data)).find(data => data.days).days;
}

test('public and admin photos follow camera time across batches, ignoring manual and import order', async () => {
  assert.equal((await post('/admin?/importPhotos', {}, [
    await photo('order-late.jpg', '2022:06:01 23:50:00'),
    await photo('order-early.jpg', '2022:06:01 00:10:00')
  ])).status, 303);
  assert.equal((await post('/admin?/importPhotos', {}, [await photo('order-middle.jpg', '2022:06:01 12:00:00')])).status, 303);
  const target = day('2022-06-01');
  database.prepare("UPDATE photos SET sort_order=CASE original_name WHEN 'order-late.jpg' THEN 0 ELSE 999 END WHERE day_id=?").run(target.id);
  const expected = ['order-early.jpg', 'order-middle.jpg', 'order-late.jpg'];
  for (const path of ['', '/admin']) {
    const loaded = (await loadedDays(path)).find(item => item.id === target.id);
    assert.deepEqual(loaded.photos.map(item => item.original_name), expected);
  }
  const late = database.prepare("SELECT * FROM photos WHERE original_name='order-late.jpg'").get();
  assert.equal((await post('/admin?/savePhoto', {id: late.id, date: target.date, sort_order: -999, caption_fr: 'Conservée'})).status, 303);
  assert.equal(database.prepare('SELECT taken_at FROM photos WHERE id=?').get(late.id).taken_at, '2022-06-01T23:50:00.000');
  const editor = await (await fetch(`${origin}/admin?day=${target.id}`, {headers: {cookie}})).text();
  assert.doesNotMatch(editor, /name="sort_order"/);

  // Moving a photo changes its editorial day, not its camera timestamp or library order.
  const early = database.prepare("SELECT * FROM photos WHERE original_name='order-early.jpg'").get();
  assert.equal((await post('/admin?/savePhoto', {id: early.id, date: '2030-01-01', caption_fr: 'Déplacée'})).status, 303);
  const library = await (await fetch(`${origin}/admin?view=photos`, {headers: {cookie}})).text();
  const ids = expected.map(name => database.prepare('SELECT id FROM photos WHERE original_name=?').get(name).id);
  const positions = ids.map(id => library.indexOf(`src="/media/${id}/thumb"`));
  assert.ok(positions.every(position => position >= 0));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
});

test('manual day uploads and undated photos use capture time with a stable display-date fallback', async () => {
  const target = day('2022-06-01');
  assert.equal((await post('/admin?/upload', {day_id: target.id}, [
    await photo('order-manual.jpg', '2022:06:01 09:00:00'), await photo('order-undated.jpg', null)
  ])).status, 303);
  const first = (await loadedDays()).find(item => item.id === target.id).photos;
  assert.deepEqual(first.map(item => item.original_name), ['order-undated.jpg', 'order-manual.jpg', 'order-middle.jpg', 'order-late.jpg']);
  assert.equal(first[0].taken_at, null);
  assert.deepEqual((await loadedDays()).find(item => item.id === target.id).photos.map(item => item.id), first.map(item => item.id));
});

test('Google photos without EXIF are ordered by Google capture time in the configured time zone', async () => {
  await connectGoogle('chronological');
  const progress = await importGoogle();
  assert.equal(progress.imported, 2);
  const loaded = (await loadedDays()).find(item => item.date === '2022-12-03');
  assert.deepEqual(loaded.photos.map(item => item.original_name), ['google-early.jpg', 'google-late.jpg']);
  assert.deepEqual(loaded.photos.map(item => item.taken_at), ['2022-12-03T00:10:00.000', '2022-12-03T00:30:00.000']);
});
