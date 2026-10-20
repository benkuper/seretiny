<?php
declare(strict_types=1);
ini_set('display_errors','0');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Cache-Control: no-store');
require __DIR__.'/server/bootstrap.php';
require __DIR__.'/server/media.php';
require __DIR__.'/server/google.php';
require __DIR__.'/server/actions.php';

$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/',PHP_URL_PATH) ?: '/');
if (BASE_PATH !== '' && !($path===BASE_PATH || str_starts_with($path,BASE_PATH.'/'))) { http_response_code(404); exit; }
$path = substr($path,strlen(BASE_PATH)); $path = rtrim($path,'/') ?: '/';
if ($path==='/index.php') $path='/';
$form=null;
try {
    if (preg_match('#^/media/([a-zA-Z0-9-]{1,50})/(thumb|large|video)$#D',$path,$m) && in_array($_SERVER['REQUEST_METHOD'],['GET','HEAD'],true)) serve_media($m[1],$m[2]);
    if ($path==='/admin/google-photos/callback' && $_SERVER['REQUEST_METHOD']==='GET') { require_admin(); google_callback(); }
    if ($path==='/admin/google-photos/status' && $_SERVER['REQUEST_METHOD']==='GET') {
        require_admin(); session_write_close(); $view=google_tick(); json_response(['ready'=>$view['ready'],'progress'=>$view['progress'],'pollAfter'=>1000]);
    }
    if ($_SERVER['REQUEST_METHOD']==='POST') {
        if ($path==='/api/comments') comments_endpoint();
        if ($path==='/admin/login') {
            check_csrf();
            if (!auth_ready()) throw new DomainException('Configure les secrets administrateur sur le serveur.');
            rate_limit('login:'.hash_hmac('sha256',$_SERVER['REMOTE_ADDR'] ?? '',setting('SESSION_SECRET')),12,900);
            if (!hash_equals(hash('sha256',setting('ADMIN_PASSWORD')),hash('sha256',field('password',10000)))) { http_response_code(401); throw new DomainException('Mot de passe incorrect.'); }
            session_regenerate_id(true); $_SESSION['csrf']=bin2hex(random_bytes(32)); $_SESSION['admin_until']=time()+604800; $_SESSION['secret_hash']=hash('sha256',setting('SESSION_SECRET')); go('/admin');
        }
        if ($path==='/admin') {
            if (preg_match('#^/([A-Za-z]+)(?:&|$)#',$_SERVER['QUERY_STRING'] ?? '',$m)) action($m[1]);
            throw new DomainException('Action inconnue.');
        }
        http_response_code(405); header('Allow: GET, HEAD'); exit;
    }
} catch (Throwable $e) {
    $message=$e instanceof DomainException ? $e->getMessage() : ($e instanceof PDOException && str_contains($e->getMessage(),'UNIQUE') ? 'Cette date ou cet élément existe déjà.' : 'Opération impossible. Réessaie dans un instant.');
    if (!$e instanceof DomainException) error_log('SereTiny: '.$e->getMessage());
    $status=http_response_code()>=400 ? http_response_code() : 400;
    if ($path==='/api/comments') json_response(['error'=>$message],$status);
    if (wants_json()) json_response(['type'=>'failure','status'=>$status,'data'=>['message'=>$message]],$status);
    http_response_code($status); $form=['message'=>$message];
}

if ($path==='/admin') {
    require_admin(); $view=$_GET['view'] ?? (isset($_GET['day']) ? 'day' : 'days');
    if (!in_array($view,['days','day','photos','imports','chapters','comments'],true)) $view='days';
    $page='admin'; $data=['view'=>$view,'days'=>days(false),'chapters'=>chapters(),'comments'=>pending_comments(),'googlePhotos'=>google_view(),'selectedId'=>(int)($_GET['day'] ?? 0),'notice'=>is_string($_GET['notice'] ?? null) ? $_GET['notice'] : '', 'warning'=>is_string($_GET['warning'] ?? null) ? $_GET['warning'] : ''];
} elseif ($path==='/admin/login') {
    if (admin()) go('/admin'); $page='login'; $data=['ready'=>auth_ready()];
} elseif ($path==='/') {
    $page='public'; $data=['days'=>days(true),'chapters'=>array_values(array_filter(chapters(),fn($c)=>$c['start_date']!==null))];
} else {
    http_response_code(404); header('Content-Type: text/html; charset=utf-8'); echo '<!doctype html><html lang="fr"><meta charset="utf-8"><title>Page introuvable</title><p>Cette page n’existe pas.</p></html>'; exit;
}
$bootstrap=['page'=>$page,'data'=>$data,'form'=>$form,'csrf'=>csrf(),'base'=>BASE_PATH];
if (wants_json()) json_response($bootstrap);
$assets=json_decode(file_get_contents(__DIR__.'/server/assets.json'),true,512,JSON_THROW_ON_ERROR);
function html(string $value): string { return htmlspecialchars($value,ENT_QUOTES | ENT_SUBSTITUTE,'UTF-8'); }
header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#483c31"><meta name="description" content="SereTiny, le journal photo de construction d’une petite maison."><title>SereTiny — Le journal d’une petite maison</title><link rel="icon" href="<?= html(BASE_PATH) ?>/favicon.svg">
<?php foreach ($assets['css'] as $css): ?><link rel="stylesheet" href="<?= html(BASE_PATH.'/'.$css) ?>"><?php endforeach; ?>
</head><body><div id="app"></div><noscript>Active JavaScript pour parcourir le journal et accéder à l’atelier.</noscript>
<script id="seretiny-data" type="application/json"><?= json_encode($bootstrap,JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) ?></script>
<script type="module" src="<?= html(BASE_PATH.'/'.$assets['js']) ?>"></script></body></html>
