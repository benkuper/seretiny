<?php
declare(strict_types=1);

// This directory and .private are denied by Apache. No secret enters the JS bundle.
function configuration(): array {
    $path = getenv('SERETINY_ENV') ?: dirname(__DIR__) . '/.private/.env';
    $values = [];
    if (is_file($path)) foreach (file($path, FILE_IGNORE_NEW_LINES) as $line) {
        if (!preg_match('/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/', $line, $m)) continue;
        $value = trim($m[2]);
        if (strlen($value) >= 2 && (($value[0] === '"' && str_ends_with($value, '"')) || ($value[0] === "'" && str_ends_with($value, "'")))) $value = substr($value, 1, -1);
        $values[$m[1]] = $value;
    }
    foreach (array_keys($values) as $key) if (getenv($key) !== false) $values[$key] = getenv($key);
    return $values;
}
$config = configuration();
function setting(string $key, string $default = ''): string { global $config; return (string)($config[$key] ?? $default); }
define('SITE_URL', rtrim(setting('SITE_URL', 'http://localhost'), '/'));
define('BASE_PATH', rtrim((string)parse_url(SITE_URL, PHP_URL_PATH), '/'));
define('PRIVATE_DIR', dirname(__DIR__) . '/.private');
define('DATA_DIR', setting('DATA_DIR', PRIVATE_DIR . '/data'));
date_default_timezone_set(setting('GOOGLE_PHOTOS_TIME_ZONE', 'Europe/Paris'));
umask(0077);
foreach ([PRIVATE_DIR, DATA_DIR, DATA_DIR . '/media', DATA_DIR . '/originals', PRIVATE_DIR . '/sessions'] as $dir) {
    if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Stockage indisponible.');
}
session_name('seretiny_php');
session_save_path(PRIVATE_DIR . '/sessions');
ini_set('session.use_strict_mode', '1');
session_set_cookie_params(['lifetime' => 2592000, 'path' => BASE_PATH . '/', 'secure' => str_starts_with(SITE_URL, 'https://'), 'httponly' => true, 'samesite' => 'Lax']);
session_start();
$_SESSION['csrf'] ??= bin2hex(random_bytes(32));
function csrf(): string { return $_SESSION['csrf']; }
function auth_ready(): bool { return strlen(setting('ADMIN_PASSWORD')) >= 12 && strlen(setting('SESSION_SECRET')) >= 32; }
function admin(): bool { return auth_ready() && ($_SESSION['admin_until'] ?? 0) > time() && hash_equals($_SESSION['secret_hash'] ?? '', hash('sha256', setting('SESSION_SECRET'))); }
function json_response(array $value, int $status = 200): never {
    http_response_code($status); header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store'); echo json_encode($value, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR); exit;
}
function wants_json(): bool { return str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'application/json'); }
function go(string $path): never {
    $location = BASE_PATH . $path;
    if (wants_json()) json_response(['type' => 'redirect', 'status' => 303, 'location' => $location]);
    header('Location: ' . $location, true, 303); exit;
}
function require_admin(): void {
    if (!admin()) {
        if (wants_json()) json_response(['type' => 'failure', 'status' => 401, 'data' => ['message' => 'Connecte-toi à l’atelier.']], 401);
        go('/admin/login');
    }
}
function check_origin(): void {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $expected = parse_url(SITE_URL, PHP_URL_SCHEME) . '://' . parse_url(SITE_URL, PHP_URL_HOST);
    if (parse_url(SITE_URL, PHP_URL_PORT)) $expected .= ':' . parse_url(SITE_URL, PHP_URL_PORT);
    if ($origin !== '' && !hash_equals($expected, $origin)) throw new DomainException('Origine de la requête invalide.');
    if (($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') throw new DomainException('Origine de la requête invalide.');
}
function check_csrf(): void {
    check_origin();
    if (!is_string($_POST['_csrf'] ?? null) || !hash_equals(csrf(), $_POST['_csrf'])) throw new DomainException('Session expirée. Recharge la page avant de réessayer.');
}
function field(string $key, int $max = 10000): string {
    if (isset($_POST[$key]) && !is_scalar($_POST[$key])) throw new DomainException('Champ invalide.');
    return mb_substr(trim((string)($_POST[$key] ?? '')), 0, $max);
}
function valid_date(string $date): bool {
    return preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date) === 1 && checkdate((int)substr($date, 5, 2), (int)substr($date, 8, 2), (int)substr($date, 0, 4));
}
function require_date(string $date): string { if (!valid_date($date)) throw new DomainException('Choisis une date valide.'); return $date; }
function positive_id(string $key = 'id'): int {
    $value = field($key, 32); if (!ctype_digit($value) || (int)$value < 1) throw new DomainException('Identifiant invalide.'); return (int)$value;
}
function selection(): array {
    $ids = $_POST['ids'] ?? [];
    if (!is_array($ids) || count($ids) < 1 || count($ids) > 500) throw new DomainException('Sélectionne entre 1 et 500 éléments.');
    foreach ($ids as $id) if (!is_string($id) || strlen($id) > 50 || !preg_match('/^[a-zA-Z0-9-]+$/D', $id)) throw new DomainException('Sélection invalide.');
    return array_values(array_unique($ids));
}
function action_success(array $value): never {
    if (wants_json()) json_response(['type' => 'success', 'status' => 200, 'data' => $value]);
    back(null, 'Enregistré.', 'photos');
}
function back(?int $id = null, string $notice = '', string $view = '', string $warning = ''): never {
    go('/admin?' . http_build_query(['view' => $view ?: ($id ? 'day' : 'days'), 'day' => $id ?: null, 'notice' => $notice, 'warning' => $warning]));
}
require_once __DIR__ . '/database.php';
