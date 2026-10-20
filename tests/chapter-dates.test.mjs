import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { photo } from './fixtures.mjs';

let directory, server, database, origin, cookie;
let logs = '';

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'seretiny-chapters-'));
  database = new Database(join(directory, 'seretiny.sqlite'));
  // Original schema: the migration must infer starts without losing content.
  database.exec(`
    CREATE TABLE chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, title_fr TEXT NOT NULL,
      title_en TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE days (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE,
      title_fr TEXT NOT NULL DEFAULT '', title_en TEXT NOT NULL DEFAULT '',
      body_fr TEXT NOT NULL DEFAULT '', body_en TEXT NOT NULL DEFAULT '',
      chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)));
    INSERT INTO chapters (title_fr,sort_order) VALUES ('Plans',0),('Construction',1),('Intérieur',2);
    INSERT INTO days (date,title_fr,body_fr,chapter_id) VALUES
      ('2024-05-31','Avant','',NULL),('2024-06-01','Les plans','Texte conservé',1),
      ('2024-06-02','La suite','',1),('2024-07-01','Le chantier','',2);
  `);
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['build/index.js'], {
    cwd: resolve('.'), windowsHide: true,
    env: {...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin,
      DATA_DIR: directory, ADMIN_PASSWORD: 'test-chapter-password',
      SESSION_SECRET: 'test-secret-for-isolated-chapter-tests-only', PROTOCOL_HEADER: 'x-forwarded-proto'},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => logs += chunk);
  server.stderr.on('data', chunk => logs += chunk);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/admin/login`)).ok) break; } catch {}
    if (attempt === 99 || server.exitCode !== null) throw new Error(`Server failed to start: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const response = await post('/admin/login', {password: 'test-chapter-password'});
  assert.equal(response.status, 303);
  cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${origin}/admin`, {headers: {cookie}})).status, 200);
});

after(async () => {
  database?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  const target = directory && resolve(directory);
  if (target?.startsWith(join(resolve(tmpdir()), 'seretiny-chapters-'))) {
    await rm(target, {recursive: true, force: true});
  }
});

function post(path, fields = {}, images = []) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
  for (const item of images) body.append('photos', new Blob([item.buffer], {type: item.type}), item.name);
  return fetch(`${origin}${path}`, {method: 'POST', body, redirect: 'manual',
    headers: {origin, accept: 'text/html', 'x-forwarded-proto': 'http', ...(cookie ? {cookie} : {})}});
}

function dayId(date) {
  return database.prepare('SELECT id FROM days WHERE date=?').get(date).id;
}

async function adminHtml(date) {
  const response = await fetch(`${origin}/admin?day=${dayId(date)}`, {headers: {cookie}});
  assert.equal(response.status, 200);
  return (await response.text()).replace(/<!--[\s\S]*?-->/g, '');
}

async function expectChapter(date, name) {
  assert.equal((await adminHtml(date)).match(/<span>Chapitre : ([^<]*)<\/span>/)?.[1], name);
}

test('migration infers first dates and preserves days and undated chapters', () => {
  assert.equal(database.pragma('user_version', {simple: true}), 2);
  assert.deepEqual(database.prepare('SELECT start_date FROM chapters ORDER BY id').all(), [
    {start_date: '2024-06-01'}, {start_date: '2024-07-01'}, {start_date: null}
  ]);
  assert.equal(database.prepare('SELECT body_fr FROM days WHERE id=2').get().body_fr, 'Texte conservé');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM days').get().n, 4);
});

test('start dates are required, valid, unique and editable', async () => {
  for (const start_date of ['', '2024-02-30', '2024-06-01', '2024-08-01extra']) {
    assert.equal((await post('/admin?/addChapter', {title_fr: 'Invalid', start_date})).status, 400);
  }
  assert.equal((await post('/admin?/saveChapter', {id: 2, title_fr: 'Construction', start_date: '2024-06-01'})).status, 400);
  assert.equal((await post('/admin?/saveChapter', {id: 9999, title_fr: 'Absent', start_date: '2024-08-01'})).status, 404);
  assert.equal((await post('/admin?/saveChapter', {id: 1, title_fr: 'Plans', start_date: '2024-06-01'})).status, 303);
});

test('start day belongs to the new chapter and the last chapter remains open', async () => {
  await expectChapter('2024-05-31', 'Sans chapitre');
  await expectChapter('2024-06-01', 'Plans');
  await expectChapter('2024-06-02', 'Plans');
  await expectChapter('2024-07-01', 'Construction');
  assert.equal((await post('/admin?/createDay', {date: '2025-01-01', title_fr: 'La suite', chapter: 1})).status, 303);
  assert.equal(database.prepare('SELECT published FROM days WHERE date=?').get('2025-01-01').published, 1);
  assert.match(await adminHtml('2025-01-01'), /name="published"[^>]*checked/);
  assert.equal((await post('/admin?/saveDay', {id: dayId('2025-01-01'), date: '2025-01-01',
    title_fr: 'La suite', published: 'on'})).status, 303);
  assert.doesNotMatch(await (await fetch(origin)).text(), /La suite/);
  await expectChapter('2025-01-01', 'Construction');
  const html = await (await fetch(`${origin}/admin?view=chapters`, {headers: {cookie}})).text();
  assert.match(html, /Jusqu’au 1 juil\. 2024 \(exclu\)/);
  assert.match(html, /En cours · sans date de fin/);
  assert.match(html, /À dater pour apparaître sur la frise/);
  assert.doesNotMatch(html, /<select[^>]*name="chapter"/);
});

test('imports and public rendering follow dates even when a manual chapter is submitted', async () => {
  const image = await photo('chapter.jpg', '2024:07:01 10:00:00');
  assert.equal((await post('/admin?/importPhotos', {chapter: 1}, [image])).status, 303);
  await expectChapter('2024-07-01', 'Construction');
  assert.equal((await post('/admin?/saveDay', {id: dayId('2024-07-01'), date: '2024-07-01',
    title_fr: 'Le chantier', published: 'on', chapter: 1})).status, 303);
  const html = (await (await fetch(origin)).text()).replace(/<!--[\s\S]*?-->/g, '');
  assert.match(html, /Construction/);
  assert.match(html, /chapitre 02/i);
});

test('changing a day or photo date recalculates the chapter', async () => {
  assert.equal((await post('/admin?/saveDay', {id: dayId('2024-06-02'), date: '2024-07-03', title_fr: 'Déplacée'})).status, 303);
  await expectChapter('2024-07-03', 'Construction');
  const image = database.prepare("SELECT id FROM photos WHERE original_name='chapter.jpg'").get();
  assert.equal((await post('/admin?/savePhoto', {id: image.id, date: '2024-06-15', caption_fr: 'Légende conservée', sort_order: 0})).status, 303);
  await expectChapter('2024-06-15', 'Plans');
  assert.equal(database.prepare('SELECT caption_fr FROM photos WHERE id=?').get(image.id).caption_fr, 'Légende conservée');
});

test('adding and reordering starts recalculates existing days and chapter ends', async () => {
  assert.equal((await post('/admin?/addChapter', {title_fr: 'Le toit', start_date: '2024-06-15'})).status, 303);
  const roof = database.prepare("SELECT id FROM chapters WHERE title_fr='Le toit'").get();
  await expectChapter('2024-06-15', 'Le toit');
  assert.equal((await post('/admin?/saveChapter', {id: 1, title_fr: 'Plans', start_date: '2024-08-01'})).status, 303);
  await expectChapter('2024-06-01', 'Sans chapitre');
  await expectChapter('2025-01-01', 'Plans');
  assert.equal((await post('/admin?/saveChapter', {id: roof.id, title_fr: 'Le toit', start_date: '2024-05-01'})).status, 303);
  await expectChapter('2024-06-01', 'Le toit');
  const html = await (await fetch(`${origin}/admin?view=chapters`, {headers: {cookie}})).text();
  const cards = [...html.matchAll(/class="chapter-card[^\"]*"[\s\S]*?<\/form>/g)].map(match => match[0]);
  assert.match(cards[0], /value="Le toit"/);
  assert.match(cards[1], /value="Construction"/);
  assert.match(cards[1], /Jusqu’au 1 août 2024 \(exclu\)/);
  assert.match(cards[2], /value="Plans"/);
});
