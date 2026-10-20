import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

let directory, server, database, origin, cookie;
let logs = '';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'seretiny-workshop-'));
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['build/index.js'], {
    cwd: resolve('.'), windowsHide: true,
    env: {...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin,
      DATA_DIR: directory, ADMIN_PASSWORD: 'test-workshop-password',
      SESSION_SECRET: 'test-secret-for-isolated-workshop-tests-only', PROTOCOL_HEADER: 'x-forwarded-proto'},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => logs += chunk);
  server.stderr.on('data', chunk => logs += chunk);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/admin/login`)).ok) break; } catch {}
    if (attempt === 99 || server.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const response = await post('/admin/login', {password: 'test-workshop-password'}, false);
  cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${origin}/admin`, {headers: {cookie}})).status, 200);
  database = new Database(join(directory, 'seretiny.sqlite'));
  database.exec(`INSERT INTO days (id,date,title_fr,body_fr,published) VALUES
    (1,'2024-06-01','Les fondations','Récit conservé',1),
    (2,'2024-06-02','Les murs','Autre récit',0);
    UPDATE chapters SET start_date='2024-06-01' WHERE id=1;
    INSERT INTO photos (id,day_id,caption_fr,caption_en,sort_order,original_name) VALUES
      ('first',1,'Première légende','First caption',3,'first.jpg'),
      ('second',2,'Deuxième légende','Second caption',7,'second.jpg'),
      ('third',2,'Troisième légende','Third caption',10,'third.jpg');
    INSERT INTO comments (id,day_id,author,body,ip_hash,created_at) VALUES
      (1,1,'Alice','Beau chantier !','test','2024-06-01T12:00:00Z'),
      (2,2,'Bob','Bravo !','test','2024-06-02T12:00:00Z');`);
});

after(async () => {
  database?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit'); server.kill(); await exited;
  }
  if (directory && resolve(directory).startsWith(join(resolve(tmpdir()), 'seretiny-workshop-'))) {
    await rm(directory, {recursive: true, force: true});
  }
});

function post(path, fields = {}, authenticated = true) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
  }
  return fetch(`${origin}${path}`, {method: 'POST', body, redirect: 'manual',
    headers: {origin, accept: 'text/html', 'x-forwarded-proto': 'http', ...(authenticated && cookie ? {cookie} : {})}});
}
async function html(query = '') {
  const response = await fetch(`${origin}/admin${query}`, {headers: {cookie}});
  assert.equal(response.status, 200);
  return (await response.text()).replace(/<!--[\s\S]*?-->/g, '');
}
const image = id => database.prepare('SELECT * FROM photos WHERE id=?').get(id);

test('menu opens focused views and existing day links still open the editor', async () => {
  const list = await html();
  assert.match(list, /Menu de l’atelier/);
  assert.match(list, /Les fondations/);
  assert.doesNotMatch(list, /name="body_fr"|id="google-import-title"|class="chapter-card[ "]/);
  assert.match(await html('?day=1'), /name="body_fr"/);
  assert.doesNotMatch(await html('?day=999'), /name="body_fr"/);
  assert.match(await html('?day=999'), /Journée introuvable/);
  const library = await html('?view=photos');
  assert.match(library, /class="library-card[ "]/);
  const cards = library.match(/<article class="library-card[\s\S]*?<\/article>/g);
  assert.equal(cards.length, 3);
  for (const card of cards) {
    assert.match(card, /class="library-image[^>]*type="button"/);
    assert.match(card, /class="edit-photo[^>]*href="\/admin\?day=/);
    assert.match(card, /title="Modifier la date"/);
    assert.match(card, /title="Modifier la légende"/);
    assert.match(card, /action="\?\/deletePhoto&amp;view=photos"/);
    assert.doesNotMatch(card, /first\.jpg|second\.jpg|third\.jpg|Affichage activé|Masquée|Modifier les détails ↗/);
  }
  assert.match(library, /<dialog[^>]*aria-label="Photo en grand"/);
  assert.doesNotMatch(await html('?view=photos'), /name="body_fr"/);
  assert.match(await html('?view=chapters'), /class="chapter-card[ "]/);
  assert.match(await html('?view=imports'), /id="google-import-title"/);
  assert.match(await html('?view=comments'), /Beau chantier/);
  assert.doesNotMatch(await html('?view=invalid'), /id="google-import-title"/);
});

test('all bulk actions require authentication and reject missing, invalid or oversized selections', async () => {
  for (const action of ['bulkDays', 'bulkPhotos', 'bulkComments']) {
    const response = await post(`/admin?/${action}`, {ids: [1]}, false);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/admin/login');
    assert.equal((await post(`/admin?/${action}`)).status, 400);
    assert.equal((await post(`/admin?/${action}`, {ids: Array(501).fill('1')})).status, 400);
  }
  assert.equal((await post('/admin?/bulkDays', {ids: ['1.5'], decision: 'hide'})).status, 400);
  assert.equal((await post('/admin?/bulkDays', {ids: [1], decision: 'delete'})).status, 400);
});

test('publication batches are atomic and keep day narratives and photo access rules', async () => {
  assert.equal((await post('/admin?/bulkDays', {ids: [1, 999], decision: 'hide'})).status, 400);
  assert.equal(database.prepare('SELECT published FROM days WHERE id=1').get().published, 1);
  const response = await post('/admin?/bulkDays', {ids: [1, 2, 2], decision: 'hide'});
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location'), origin).searchParams.get('view'), 'days');
  assert.deepEqual(database.prepare('SELECT published FROM days ORDER BY id').all(), [{published: 0}, {published: 0}]);
  assert.equal((await fetch(`${origin}/media/first/thumb`)).status, 404);
  assert.equal((await post('/admin?/bulkDays', {ids: [1, 2], decision: 'publish'})).status, 303);
  assert.equal(database.prepare('SELECT body_fr FROM days WHERE id=1').get().body_fr, 'Récit conservé');
});

test('photo batches change only checked fields and can explicitly clear captions', async () => {
  assert.equal((await post('/admin?/bulkPhotos', {ids: ['first'], caption_fr: 'Ignored'})).status, 400);
  const response = await post('/admin?/bulkPhotos', {ids: ['first', 'second'], change_caption_fr: 'on', caption_fr: 'Légende commune', caption_en: 'Ignored', date: 'invalid'});
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location'), origin).searchParams.get('view'), 'photos');
  assert.equal(image('first').caption_fr, 'Légende commune');
  assert.equal(image('second').caption_en, 'Second caption');
  assert.equal(image('first').day_id, 1);
  assert.equal((await post('/admin?/bulkPhotos', {ids: ['first', 'second'], change_caption_en: 'on', caption_en: ''})).status, 303);
  assert.equal(image('first').caption_en, '');
  assert.equal(image('second').caption_en, '');
});

test('photo batches validate dates and all IDs before creating a day or changing captions', async () => {
  for (const date of ['', '2024-02-30', '2024-06-03extra']) {
    assert.equal((await post('/admin?/bulkPhotos', {ids: ['first'], change_date: 'on', date})).status, 400);
  }
  assert.equal((await post('/admin?/bulkPhotos', {ids: ['first', 'missing'], change_date: 'on', date: '2024-06-03', change_caption_fr: 'on', caption_fr: 'Unwanted'})).status, 400);
  assert.equal(database.prepare("SELECT id FROM days WHERE date='2024-06-03'").get(), undefined);
  assert.equal(image('first').caption_fr, 'Légende commune');
  assert.equal(image('first').day_id, 1);
});

test('moving a selection appends to existing order and creates only one new day when needed', async () => {
  assert.equal((await post('/admin?/bulkPhotos', {ids: ['first', 'second'], change_date: 'on', date: '2024-06-02'})).status, 303);
  assert.equal(image('first').day_id, 2);
  assert.equal(image('first').sort_order, 11);
  assert.equal(image('second').sort_order, 7);
  assert.equal(image('third').sort_order, 10);
  assert.equal((await post('/admin?/bulkPhotos', {ids: ['first', 'second'], change_date: 'on', date: '2024-07-01'})).status, 303);
  const target = database.prepare("SELECT * FROM days WHERE date='2024-07-01'").get();
  assert.equal(target.published, 1);
  assert.equal(image('first').day_id, target.id);
  assert.equal(image('second').day_id, target.id);
  assert.equal(image('first').caption_fr, 'Légende commune');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM days').get().n, 3);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 2);
  assert.equal(database.prepare('SELECT body_fr FROM days WHERE id=1').get().body_fr, 'Récit conservé');
});

test('batch moderation handles only pending comments and rejects a stale batch atomically', async () => {
  assert.equal((await post('/admin?/bulkComments', {ids: [1, 999], decision: 'approve'})).status, 400);
  assert.equal(database.prepare('SELECT approved FROM comments WHERE id=1').get().approved, 0);
  const response = await post('/admin?/bulkComments', {ids: [1], decision: 'approve'});
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location'), origin).searchParams.get('view'), 'comments');
  assert.equal((await post('/admin?/bulkComments', {ids: [1, 2], decision: 'delete'})).status, 400);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 2);
  assert.equal((await post('/admin?/bulkComments', {ids: [2], decision: 'delete'})).status, 303);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 1);
});

test('direct caption editing preserves the date, English caption and ordering', async () => {
  const before = image('third');
  const response = await post('/admin?/editLibraryPhoto&view=photos', {
    id: 'third', edit: 'caption', caption_fr: 'Une nouvelle légende', date: 'bad', caption_en: 'Ignored', sort_order: 999
  });
  assert.equal(response.status, 200);
  assert.deepEqual(image('third'), {...before, caption_fr: 'Une nouvelle légende'});
  assert.equal((await post('/admin?/editLibraryPhoto&view=photos', {id: 'third', edit: 'caption', caption_fr: ''})).status, 200);
  assert.equal(image('third').caption_fr, '');
});

test('direct date editing validates the date and keeps captions while moving the photo', async () => {
  const before = image('third');
  assert.equal((await post('/admin?/editLibraryPhoto&view=photos', {id: 'third', edit: 'date', date: '2024-02-30'})).status, 400);
  assert.deepEqual(image('third'), before);
  assert.equal((await post('/admin?/editLibraryPhoto&view=photos', {id: 'third', edit: 'date', date: '2024-08-01'})).status, 200);
  const target = database.prepare("SELECT * FROM days WHERE date='2024-08-01'").get();
  assert.equal(image('third').day_id, target.id);
  assert.equal(image('third').caption_en, before.caption_en);
  assert.equal(target.published, 1);
  assert.equal((await post('/admin?/editLibraryPhoto&view=photos', {id: 'missing', edit: 'caption', caption_fr: 'No'})).status, 400);
  assert.equal((await post('/admin?/editLibraryPhoto&view=photos', {id: 'third', edit: 'unknown'})).status, 400);
  assert.equal((await post('/admin?/editLibraryPhoto&view=photos', {id: 'third', edit: 'caption'}, false)).headers.get('location'), '/admin/login');
});

test('library deletion returns to the library and leaves other photos and narratives intact', async () => {
  const before = image('second');
  assert.equal((await post('/admin?/deletePhoto&view=photos', {id: 'first'}, false)).headers.get('location'), '/admin/login');
  const response = await post('/admin?/deletePhoto&view=photos', {id: 'first'});
  assert.equal(response.status, 200);
  assert.equal(image('first'), undefined);
  assert.deepEqual(image('second'), before);
  assert.equal(database.prepare('SELECT body_fr FROM days WHERE id=1').get().body_fr, 'Récit conservé');
});
