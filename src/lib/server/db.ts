import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Chapter, Day, Photo, Comment } from '#lib/types.js';
import { DATA_DIR as configuredDataDir } from '$app/env/private';

export const DATA_DIR = resolve(configuredDataDir || './data');
export const MEDIA_DIR = join(DATA_DIR, 'media');
export const ORIGINALS_DIR = join(DATA_DIR, 'originals');
for (const dir of [DATA_DIR, MEDIA_DIR, ORIGINALS_DIR]) mkdirSync(dir, { recursive: true });

const db = new Database(join(DATA_DIR, 'seretiny.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_fr TEXT NOT NULL,
  title_en TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  title_fr TEXT NOT NULL DEFAULT '',
  title_en TEXT NOT NULL DEFAULT '',
  body_fr TEXT NOT NULL DEFAULT '',
  body_en TEXT NOT NULL DEFAULT '',
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1))
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  caption_fr TEXT NOT NULL DEFAULT '',
  caption_en TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  original_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1))
);
CREATE INDEX IF NOT EXISTS photos_by_day ON photos(day_id, sort_order);
CREATE INDEX IF NOT EXISTS comments_by_day ON comments(day_id, approved, created_at);
CREATE INDEX IF NOT EXISTS comments_rate ON comments(ip_hash, created_at);
`);

// Named, additive migration, independent of the chapter migrations' user_version.
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
if (!db.prepare('SELECT name FROM schema_migrations WHERE name=?').get('001-photo-sources')) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS photo_sources (
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      PRIMARY KEY (source, source_id)
    );
    CREATE INDEX IF NOT EXISTS photo_sources_by_photo ON photo_sources(photo_id);`);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('001-photo-sources');
  })();
}

// Persist Google connections without changing existing photos or chapter migrations.
if (!db.prepare('SELECT name FROM schema_migrations WHERE name=?').get('002-google-connections')) {
  db.transaction(() => {
    db.exec(`CREATE TABLE google_connections (
      id TEXT PRIMARY KEY,
      encrypted_payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );`);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('002-google-connections');
  })();
}

// Keep camera time separate from the editable display day and legacy ordering.
if (!db.prepare('SELECT name FROM schema_migrations WHERE name=?').get('003-photo-taken-at')) {
  db.transaction(() => {
    db.exec('ALTER TABLE photos ADD COLUMN taken_at TEXT');
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('003-photo-taken-at');
  })();
}

export function photosWithoutTakenDate(): {id: string}[] {
  return db.prepare("SELECT id FROM photos WHERE taken_at IS NULL AND kind='photo'").all() as {id:string}[];
}

export function rememberPhotoTakenAt(id: string, takenAt: string) {
  db.prepare('UPDATE photos SET taken_at=? WHERE id=? AND taken_at IS NULL').run(takenAt, id);
}

if (!db.prepare('SELECT name FROM schema_migrations WHERE name=?').get('004-video-media')) {
  db.transaction(() => {
    db.exec("ALTER TABLE photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo' CHECK(kind IN ('photo','video'))");
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('004-video-media');
  })();
}

export function savedGoogleConnection(id: string): string | undefined {
  db.prepare('DELETE FROM google_connections WHERE expires_at<=?').run(Date.now());
  return (db.prepare('SELECT encrypted_payload FROM google_connections WHERE id=?').get(id) as {encrypted_payload:string}|undefined)?.encrypted_payload;
}

export function saveGoogleConnection(id: string, encrypted: string, expiresAt: number) {
  db.prepare(`INSERT INTO google_connections (id,encrypted_payload,expires_at) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET encrypted_payload=excluded.encrypted_payload,expires_at=excluded.expires_at`)
    .run(id, encrypted, expiresAt);
}

export function forgetGoogleConnection(id: string) {
  db.prepare('DELETE FROM google_connections WHERE id=?').run(id);
}

// Infer existing chapter starts without changing any days, photos or captions.
// Chapters without days stay undated until their start is set in the admin.
if (Number(db.pragma('user_version', {simple: true})) < 2) {
  db.transaction(() => {
    db.exec(`ALTER TABLE chapters ADD COLUMN start_date TEXT
      CHECK(start_date IS NULL OR (length(start_date) = 10 AND start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));
      UPDATE chapters SET start_date = (SELECT MIN(date) FROM days WHERE chapter_id = chapters.id);
      CREATE UNIQUE INDEX chapters_by_start_date ON chapters(start_date);`);
    db.pragma('user_version = 2');
  })();
}

if ((db.prepare('SELECT COUNT(*) AS total FROM chapters').get() as {total:number}).total === 0) {
  const insert = db.prepare('INSERT INTO chapters (title_fr,title_en,sort_order) VALUES (?,?,?)');
  db.transaction(() => {
    insert.run('Les premiers plans', 'First sketches', 0);
    insert.run('La construction', 'The build', 1);
    insert.run("L'aménagement", 'Making it home', 2);
  })();
}

export function dateValid(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === v;
}

export function chapters(): Chapter[] {
  return db.prepare(`SELECT c.*,
    (SELECT MIN(start_date) FROM chapters WHERE start_date > c.start_date) AS end_date
    FROM chapters c ORDER BY start_date IS NULL, start_date, sort_order, id`).all() as Chapter[];
}

export function days(publicOnly = false): Day[] {
  const sql = `SELECT d.id, d.date, d.title_fr, d.title_en, d.body_fr, d.body_en, d.published,
    c.id AS chapter_id, c.title_fr AS chapter_fr, c.title_en AS chapter_en
    FROM days d LEFT JOIN chapters c ON c.id = (
      SELECT id FROM chapters WHERE start_date <= d.date ORDER BY start_date DESC LIMIT 1
    )
    ${publicOnly ? 'WHERE d.published = 1 AND EXISTS (SELECT 1 FROM photos p WHERE p.day_id = d.id)' : ''}
    ORDER BY d.date ASC, d.id ASC`;
  const rows = db.prepare(sql).all() as Omit<Day,'photos'|'comments'>[];
  const getPhotos = db.prepare(`SELECT * FROM photos WHERE day_id = ?
    ORDER BY COALESCE(taken_at, (SELECT date FROM days WHERE id=photos.day_id) || 'T00:00:00.000'), id`);
  const getComments = db.prepare(`SELECT id, day_id, author, body, created_at, approved FROM comments
    WHERE day_id = ? ${publicOnly ? 'AND approved = 1' : ''} ORDER BY created_at ASC, id ASC`);
  return rows.map(row => ({
    ...row,
    photos: getPhotos.all(row.id) as Photo[],
    comments: getComments.all(row.id) as Comment[]
  }));
}

export function getDay(id: number): Day | undefined {
  return days(false).find(day => day.id === id);
}

export function createDay(date: string, titleFr: string): number {
  if (!dateValid(date)) throw new Error('Date invalide');
  const result = db.prepare('INSERT INTO days (date,title_fr,published) VALUES (?,?,1)')
    .run(date, titleFr.trim().slice(0,150));
  return Number(result.lastInsertRowid);
}

export function updateDay(id: number, value: {
  date: string; title_fr: string; title_en: string;
  body_fr: string; body_en: string; published: number;
}) {
  if (!dateValid(value.date)) throw new Error('Date invalide');
  db.prepare(`UPDATE days SET date=@date,title_fr=@title_fr,title_en=@title_en,
  body_fr=@body_fr,body_en=@body_en,published=@published WHERE id=@id`)
    .run({ ...value, id });
}

export function deleteDay(id: number) {
  const photoIds = (db.prepare('SELECT id FROM photos WHERE day_id=?').all(id) as {id:string}[]).map(v=>v.id);
  db.prepare('DELETE FROM days WHERE id = ?').run(id);
  return photoIds;
}

export function photoCount(dayId: number) {
  return (db.prepare('SELECT COUNT(*) AS n FROM photos WHERE day_id=?').get(dayId) as {n:number}).n;
}

export type PhotoSource = { source: 'sha256' | 'google'; source_id: string };

export class DuplicatePhotoError extends Error {
  constructor(public photoId?: string) { super('Photo déjà importée.'); }
}

export function importedPhoto(source: PhotoSource): {id: string; day_id: number} | undefined {
  return db.prepare(`SELECT p.id, p.day_id FROM photo_sources s JOIN photos p ON p.id=s.photo_id
    WHERE s.source=? AND s.source_id=?`).get(source.source, source.source_id) as {id:string;day_id:number}|undefined;
}

export function rememberPhotoSource(photoId: string, source: PhotoSource) {
  db.prepare('INSERT OR IGNORE INTO photo_sources (source,source_id,photo_id) VALUES (?,?,?)')
    .run(source.source, source.source_id, photoId);
}

export function unhashedPhotos(): {id: string}[] {
  return db.prepare(`SELECT id FROM photos WHERE NOT EXISTS
    (SELECT 1 FROM photo_sources WHERE photo_id=photos.id AND source='sha256')`).all() as {id:string}[];
}

export function insertPhoto(photo: Photo, sources: PhotoSource[] = []) {
  db.transaction(() => {
    for (const source of sources) {
      const existing = importedPhoto(source);
      if (existing) throw new DuplicatePhotoError(existing.id);
    }
    db.prepare(`INSERT INTO photos (id,day_id,taken_at,kind,caption_fr,caption_en,sort_order,original_name)
      VALUES (@id,@day_id,@taken_at,@kind,@caption_fr,@caption_en,@sort_order,@original_name)`).run(photo);
    for (const source of sources) rememberPhotoSource(photo.id, source);
  })();
}

export function insertPhotoForDate(photo: Pick<Photo, 'id' | 'original_name' | 'taken_at' | 'kind'>, date: string, sources: PhotoSource[] = []) {
  if (!dateValid(date)) throw new Error('Date de photo invalide');
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM days WHERE date=?').get(date) as {id:number}|undefined;
    const dayId = existing?.id ?? createDay(date, 'Une journée à raconter');
    const order = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM photos WHERE day_id=?')
      .get(dayId) as {n:number}).n;
    insertPhoto({ id: photo.id, original_name: photo.original_name, taken_at: photo.taken_at, kind: photo.kind, day_id: dayId, caption_fr: '', caption_en: '', sort_order: order }, sources);
    return { dayId, created: !existing };
  })();
}

export function photoAccess(id: string): { id:string; published:number; kind: Photo['kind'] } | undefined {
  return db.prepare('SELECT p.id, p.kind, d.published FROM photos p JOIN days d ON d.id=p.day_id WHERE p.id=?')
    .get(id) as {id:string; published:number; kind: Photo['kind']}|undefined;
}

export function moveAndEditPhoto(id: string, date: string, captionFr: string, captionEn: string) {
  if (!dateValid(date)) throw new Error('Date de photo invalide');
  const photo = db.prepare('SELECT day_id FROM photos WHERE id=?')
    .get(id) as {day_id:number}|undefined;
  if (!photo) throw new Error('Photo introuvable');
  db.transaction(() => {
    let target = db.prepare('SELECT id FROM days WHERE date=?').get(date) as {id:number}|undefined;
    if (!target) {
      const id = createDay(date, 'Une journée à raconter');
      target = {id};
    }
    db.prepare(`UPDATE photos SET day_id=?,caption_fr=?,caption_en=? WHERE id=?`)
      .run(target.id, captionFr.trim().slice(0,500), captionEn.trim().slice(0,500),id);
  })();
}

export function removePhoto(id: string) {
  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
}

function validateChapterStart(startDate: string, id = 0) {
  if (!dateValid(startDate)) throw new Error('Choisis une date de début valide.');
  if (db.prepare('SELECT id FROM chapters WHERE start_date=? AND id<>?').get(startDate, id)) {
    throw new Error('Un chapitre commence déjà à cette date.');
  }
}

export function addChapter(fr: string, en: string, startDate: string): number {
  validateChapterStart(startDate);
  const max = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM chapters').get() as {n:number}).n;
  const result = db.prepare('INSERT INTO chapters (title_fr,title_en,start_date,sort_order) VALUES (?,?,?,?)')
    .run(fr.trim().slice(0,100), en.trim().slice(0,100), startDate, max+1);
  return Number(result.lastInsertRowid);
}

export function editChapter(id: number, fr: string, en: string, startDate: string) {
  validateChapterStart(startDate, id);
  db.prepare('UPDATE chapters SET title_fr=?,title_en=?,start_date=? WHERE id=?')
    .run(fr.trim().slice(0,100), en.trim().slice(0,100), startDate, id);
}

export function createComment(dayId: number, author: string, body: string, ipHash: string) {
  const published = db.prepare('SELECT published FROM days WHERE id=?').get(dayId) as {published:number}|undefined;
  if (!published?.published || photoCount(dayId) === 0) throw new Error('Journée introuvable');
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const recent = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE ip_hash=? AND created_at>=?')
    .get(ipHash, since) as {n:number};
  if (recent.n >= 3) throw new Error('Trop de commentaires envoyés récemment. Réessaie plus tard.');
  db.prepare('INSERT INTO comments (day_id,author,body,ip_hash,created_at) VALUES (?,?,?,?,?)')
    .run(dayId,author.trim().slice(0,60),body.trim().slice(0,1000),ipHash,new Date().toISOString());
}

export function pendingComments(): Comment[] {
  return db.prepare('SELECT id,day_id,author,body,created_at,approved FROM comments WHERE approved=0 ORDER BY created_at DESC')
    .all() as Comment[];
}

export function moderateComment(id: number, decision: 'approve'|'delete') {
  if (decision === 'approve') db.prepare('UPDATE comments SET approved=1 WHERE id=?').run(id);
  else db.prepare('DELETE FROM comments WHERE id=?').run(id);
}

// Validate the entire selection inside one transaction: a stale ID must never
// leave a batch partially applied.
export function bulkPublishDays(ids: number[], published: 0 | 1) {
  db.transaction(() => {
    const exists = db.prepare('SELECT id FROM days WHERE id=?');
    if (ids.some(id => !exists.get(id))) throw new Error('Une journée sélectionnée n’existe plus. Recharge la liste.');
    const update = db.prepare('UPDATE days SET published=? WHERE id=?');
    for (const id of ids) update.run(published, id);
  })();
}

export function bulkEditPhotos(ids: string[], change: {date?: string; caption_fr?: string; caption_en?: string}) {
  if (change.date !== undefined && !dateValid(change.date)) throw new Error('Choisis une date d’affichage valide.');
  return db.transaction(() => {
    const get = db.prepare('SELECT * FROM photos WHERE id=?');
    const photos = ids.map(id => get.get(id) as Photo | undefined);
    if (photos.some(photo => !photo)) throw new Error('Une photo sélectionnée n’existe plus. Recharge la liste.');
    let targetId: number | undefined;
    if (change.date) {
      const target = db.prepare('SELECT id FROM days WHERE date=?').get(change.date) as {id: number} | undefined;
      targetId = target?.id ?? createDay(change.date, 'Une journée à raconter');
    }
    let nextOrder = targetId === undefined ? 0 : (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM photos WHERE day_id=?').get(targetId) as {n: number}).n;
    const update = db.prepare('UPDATE photos SET day_id=?,sort_order=?,caption_fr=?,caption_en=? WHERE id=?');
    for (const photo of photos as Photo[]) {
      const moving = targetId !== undefined && targetId !== photo.day_id;
      update.run(targetId ?? photo.day_id, moving ? nextOrder++ : photo.sort_order,
        change.caption_fr ?? photo.caption_fr, change.caption_en ?? photo.caption_en, photo.id);
    }
    return targetId;
  })();
}

export function bulkModerateComments(ids: number[], decision: 'approve' | 'delete') {
  db.transaction(() => {
    const pending = db.prepare('SELECT id FROM comments WHERE id=? AND approved=0');
    if (ids.some(id => !pending.get(id))) throw new Error('Un commentaire sélectionné a déjà été traité. Recharge la liste.');
    for (const id of ids) moderateComment(id, decision);
  })();
}
