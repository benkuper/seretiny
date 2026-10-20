<?php
declare(strict_types=1);

function db(): PDO {
    static $db;
    if ($db) return $db;
    $db = new PDO('sqlite:' . DATA_DIR . '/seretiny.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $db->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL');
    $db->beginTransaction();
    try {
        $db->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS chapters (id INTEGER PRIMARY KEY AUTOINCREMENT,title_fr TEXT NOT NULL,title_en TEXT NOT NULL DEFAULT '',sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS days (id INTEGER PRIMARY KEY AUTOINCREMENT,date TEXT NOT NULL UNIQUE,title_fr TEXT NOT NULL DEFAULT '',title_en TEXT NOT NULL DEFAULT '',body_fr TEXT NOT NULL DEFAULT '',body_en TEXT NOT NULL DEFAULT '',chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)));
CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY,day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,caption_fr TEXT NOT NULL DEFAULT '',caption_en TEXT NOT NULL DEFAULT '',sort_order INTEGER NOT NULL DEFAULT 0,original_name TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT,day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,author TEXT NOT NULL,body TEXT NOT NULL,ip_hash TEXT NOT NULL,created_at TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)));
CREATE INDEX IF NOT EXISTS photos_by_day ON photos(day_id,sort_order);
CREATE INDEX IF NOT EXISTS comments_by_day ON comments(day_id,approved,created_at);
CREATE INDEX IF NOT EXISTS comments_rate ON comments(ip_hash,created_at);
CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY);
SQL);
        $migrations = [
            '001-photo-sources' => 'CREATE TABLE IF NOT EXISTS photo_sources (source TEXT NOT NULL,source_id TEXT NOT NULL,photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,PRIMARY KEY(source,source_id)); CREATE INDEX IF NOT EXISTS photo_sources_by_photo ON photo_sources(photo_id)',
            '002-google-connections' => 'CREATE TABLE IF NOT EXISTS google_connections (id TEXT PRIMARY KEY,encrypted_payload TEXT NOT NULL,expires_at INTEGER NOT NULL)',
            '003-photo-taken-at' => 'ALTER TABLE photos ADD COLUMN taken_at TEXT',
            '004-video-media' => "ALTER TABLE photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo' CHECK(kind IN ('photo','video'))",
            '005-php-support' => 'CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS php_google_flows (id TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_at INTEGER NOT NULL)'
        ];
        foreach ($migrations as $name => $sql) {
            $stmt = $db->prepare('SELECT 1 FROM schema_migrations WHERE name=?'); $stmt->execute([$name]);
            if ($stmt->fetchColumn()) continue;
            $db->exec($sql); $db->prepare('INSERT INTO schema_migrations(name) VALUES (?)')->execute([$name]);
        }
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 2) {
            $db->exec('ALTER TABLE chapters ADD COLUMN start_date TEXT; UPDATE chapters SET start_date=(SELECT MIN(date) FROM days WHERE chapter_id=chapters.id); CREATE UNIQUE INDEX chapters_by_start_date ON chapters(start_date); PRAGMA user_version=2');
        }
        if (!(int)$db->query('SELECT COUNT(*) FROM chapters')->fetchColumn()) {
            $stmt = $db->prepare('INSERT INTO chapters(title_fr,title_en,sort_order) VALUES (?,?,?)');
            foreach ([['Les premiers plans','First sketches',0],['La construction','The build',1],["L’aménagement",'Making it home',2]] as $chapter) $stmt->execute($chapter);
        }
        $db->commit();
    } catch (Throwable $e) { $db->rollBack(); throw $e; }
    return $db;
}
function query(string $sql, array $params = []): PDOStatement { $stmt = db()->prepare($sql); $stmt->execute($params); return $stmt; }
function transaction(callable $fn): mixed {
    db()->beginTransaction();
    try { $result = $fn(); db()->commit(); return $result; } catch (Throwable $e) { db()->rollBack(); throw $e; }
}
function chapters(): array { return query('SELECT c.*,(SELECT MIN(start_date) FROM chapters WHERE start_date>c.start_date) AS end_date FROM chapters c ORDER BY start_date IS NULL,start_date,sort_order,id')->fetchAll(); }
function days(bool $public): array {
    $where = $public ? 'WHERE d.published=1 AND EXISTS(SELECT 1 FROM photos p WHERE p.day_id=d.id)' : '';
    $days = query("SELECT d.id,d.date,d.title_fr,d.title_en,d.body_fr,d.body_en,d.published,c.id AS chapter_id,c.title_fr AS chapter_fr,c.title_en AS chapter_en FROM days d LEFT JOIN chapters c ON c.id=(SELECT id FROM chapters WHERE start_date<=d.date ORDER BY start_date DESC LIMIT 1) $where ORDER BY d.date,d.id")->fetchAll();
    foreach ($days as &$day) {
        $day['photos'] = query("SELECT * FROM photos WHERE day_id=? ORDER BY COALESCE(taken_at,? || 'T00:00:00.000'),id", [$day['id'], $day['date']])->fetchAll();
        $day['comments'] = query('SELECT id,day_id,author,body,created_at,approved FROM comments WHERE day_id=?' . ($public ? ' AND approved=1' : '') . ' ORDER BY created_at,id', [$day['id']])->fetchAll();
    }
    return $days;
}
function pending_comments(): array { return query('SELECT id,day_id,author,body,created_at,approved FROM comments WHERE approved=0 ORDER BY created_at DESC')->fetchAll(); }
function require_row(string $table, string|int $id, bool $pending = false): array {
    if (!in_array($table, ['days','photos','chapters','comments'], true)) throw new LogicException('Table invalide.');
    $row = query("SELECT * FROM $table WHERE id=?" . ($pending ? ' AND approved=0' : ''), [$id])->fetch();
    if (!$row) throw new DomainException('Un élément sélectionné n’existe plus. Recharge la page.'); return $row;
}
function create_day(string $date, string $title = 'Une journée à raconter'): int {
    require_date($date); query('INSERT INTO days(date,title_fr,published) VALUES (?,?,1)', [$date, $title]); return (int)db()->lastInsertId();
}
function day_for_date(string $date): array {
    require_date($date); $id = query('SELECT id FROM days WHERE date=?', [$date])->fetchColumn();
    return ['dayId' => $id ? (int)$id : create_day($date), 'created' => !$id];
}
function edit_photos(array $ids, array $change): void {
    if (!$change) throw new DomainException('Coche au moins un champ à modifier.');
    if (isset($change['date'])) require_date($change['date']);
    transaction(function () use ($ids, $change) {
        $photos = array_map(fn($id) => require_row('photos', $id), $ids);
        $target = isset($change['date']) ? day_for_date($change['date'])['dayId'] : null;
        $order = $target ? (int)query('SELECT COALESCE(MAX(sort_order),-1)+1 FROM photos WHERE day_id=?', [$target])->fetchColumn() : 0;
        foreach ($photos as $photo) query('UPDATE photos SET day_id=?,sort_order=?,caption_fr=?,caption_en=? WHERE id=?', [
            $target ?? $photo['day_id'], $target && $target !== $photo['day_id'] ? $order++ : $photo['sort_order'],
            $change['caption_fr'] ?? $photo['caption_fr'], $change['caption_en'] ?? $photo['caption_en'], $photo['id']
        ]);
    });
}
function remove_files(string $id): void {
    if (!preg_match('/^[a-zA-Z0-9-]+$/D', $id)) throw new LogicException('Identifiant média invalide.');
    foreach (['media','originals'] as $dir) foreach (glob(DATA_DIR . "/$dir/$id.*") ?: [] as $file) unlink($file);
    $thumb = DATA_DIR . "/media/{$id}_sm.webp"; if (is_file($thumb)) unlink($thumb);
}
function rate_limit(string $key, int $limit, int $seconds): void {
    transaction(function () use ($key, $limit, $seconds) {
        query('DELETE FROM rate_limits WHERE expires_at<=?', [time()]);
        $row = query('SELECT hits FROM rate_limits WHERE key=?', [$key])->fetch();
        if ($row && $row['hits'] >= $limit) throw new DomainException('Trop de tentatives. Réessaie plus tard.');
        query('INSERT INTO rate_limits(key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1', [$key, time()+$seconds]);
    });
}
