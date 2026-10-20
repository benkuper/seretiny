<?php
declare(strict_types=1);

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
// Tests can supply a transport without contacting a real Google account.
final class GoogleTransport { public static ?Closure $override = null; }
function google_configured(): bool { return setting('GOOGLE_PHOTOS_CLIENT_ID') !== '' && setting('GOOGLE_PHOTOS_CLIENT_SECRET') !== ''; }
function google_key(): string { return hash('sha256', "seretiny/php-google/v1\0" . setting('SESSION_SECRET'), true); }
function google_id(bool $create = false): ?string {
    $id = $_COOKIE['seretiny_google_php'] ?? null;
    if (is_string($id) && preg_match('/^[a-f0-9]{64}$/D', $id)) return hash('sha256', $id);
    if (!$create) return null;
    $id = bin2hex(random_bytes(32));
    setcookie('seretiny_google_php', $id, ['expires'=>time()+2592000,'path'=>BASE_PATH.'/','secure'=>str_starts_with(SITE_URL,'https://'),'httponly'=>true,'samesite'=>'Lax']);
    $_COOKIE['seretiny_google_php'] = $id; return hash('sha256',$id);
}
function google_flow(): array {
    $id = google_id(); if (!$id) return [];
    $row = query('SELECT payload FROM php_google_flows WHERE id=? AND expires_at>?', [$id,time()])->fetch();
    if (!$row) return [];
    try {
        $raw = base64_decode($row['payload'],true);
        if ($raw === false || strlen($raw)<28) return [];
        $json = openssl_decrypt(substr($raw,28),'aes-256-gcm',google_key(),OPENSSL_RAW_DATA,substr($raw,0,12),substr($raw,12,16),$id.':'.setting('GOOGLE_PHOTOS_CLIENT_ID'));
        return $json === false ? [] : json_decode($json,true,512,JSON_THROW_ON_ERROR);
    } catch (Throwable) { return []; }
}
function save_google(array $flow): void {
    $id = google_id(true); $iv = random_bytes(12); $tag = '';
    $encrypted = openssl_encrypt(json_encode($flow,JSON_THROW_ON_ERROR),'aes-256-gcm',google_key(),OPENSSL_RAW_DATA,$iv,$tag,$id.':'.setting('GOOGLE_PHOTOS_CLIENT_ID'));
    if ($encrypted === false) throw new RuntimeException('Chiffrement Google indisponible.');
    query('DELETE FROM php_google_flows WHERE expires_at<=?', [time()]);
    query('INSERT INTO php_google_flows(id,payload,expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at', [$id,base64_encode($iv.$tag.$encrypted),time()+2592000]);
}
function google_http(string $url, string $method = 'GET', array $headers = [], ?string $body = null, ?string $file = null, int $limit = 2097152): array {
    if (GoogleTransport::$override !== null) return (GoogleTransport::$override)($url,$method,$headers,$body,$file,$limit);
    for ($attempt=0; $attempt<3; $attempt++) {
        $result = ''; $written = 0; $tooLarge = false; $handle = $file ? fopen($file,'wb') : null;
        $curl = curl_init($url);
        curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST=>$method,CURLOPT_HTTPHEADER=>$headers,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_CONNECTTIMEOUT=>20,CURLOPT_TIMEOUT=>$file ? 120 : 30,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,
            CURLOPT_WRITEFUNCTION=>function ($curl, string $chunk) use (&$result,&$written,&$tooLarge,$handle,$limit) {
                $written += strlen($chunk); if ($written>$limit) { $tooLarge=true; return 0; }
                if ($handle) return fwrite($handle,$chunk); $result .= $chunk; return strlen($chunk);
            }]);
        if ($body !== null) curl_setopt($curl,CURLOPT_POSTFIELDS,$body);
        $ok = curl_exec($curl); $errno = curl_errno($curl); $status = curl_getinfo($curl,CURLINFO_RESPONSE_CODE); curl_close($curl); if ($handle) fclose($handle);
        if ($tooLarge) throw new DomainException('Fichier Google trop volumineux pour être importé.');
        if ($ok !== false && $status>=200 && $status<300) return $file ? [] : json_decode($result,true,512,JSON_THROW_ON_ERROR);
        if ($ok === false && in_array($errno,[CURLE_OPERATION_TIMEDOUT,CURLE_COULDNT_CONNECT,CURLE_COULDNT_RESOLVE_HOST,CURLE_RECV_ERROR,CURLE_PARTIAL_FILE],true) && $attempt<2) { usleep(($attempt+1)*500000); continue; }
        if ($status === 401 || $status === 403) throw new DomainException('Autorisation Google refusée ou expirée. Reconnecte le compte.');
        if ($status === 400 && str_contains($result,'invalid_grant')) throw new DomainException('Autorisation Google expirée. Reconnecte le compte.');
        throw new DomainException($status ? 'Google Photos refuse cette opération. Réessaie la sélection.' : 'Impossible de joindre Google Photos. Réessaie dans un instant.');
    }
    throw new DomainException('Google Photos indisponible.');
}
function google_token_exchange(array $fields): array {
    $headers = ['Content-Type: application/x-www-form-urlencoded']; $body = http_build_query(array_merge(['client_id'=>setting('GOOGLE_PHOTOS_CLIENT_ID'),'client_secret'=>setting('GOOGLE_PHOTOS_CLIENT_SECRET')],$fields));
    try { return google_http('https://oauth2.googleapis.com/token','POST',$headers,$body); }
    catch (DomainException $e) {
        if ($e->getMessage() !== 'Impossible de joindre Google Photos. Réessaie dans un instant.') throw $e;
        return google_http('https://www.googleapis.com/oauth2/v4/token','POST',$headers,$body);
    }
}
function google_token(array &$flow): string {
    if (!empty($flow['token']) && ($flow['expires'] ?? 0)>time()+60) return $flow['token'];
    if (empty($flow['refreshToken'])) throw new DomainException('La connexion Google Photos a expiré. Reconnecte le compte.');
    $token = google_token_exchange(['grant_type'=>'refresh_token','refresh_token'=>$flow['refreshToken']]);
    if (empty($token['access_token'])) throw new DomainException('Renouvellement Google Photos invalide.');
    $flow['token'] = $token['access_token']; $flow['expires'] = time()+(int)($token['expires_in'] ?? 3600);
    if (!empty($token['refresh_token'])) $flow['refreshToken'] = $token['refresh_token']; save_google($flow); return $flow['token'];
}
function google_api(array &$flow, string $path, string $method = 'GET', ?array $body = null): array {
    return google_http('https://photospicker.googleapis.com/v1/'.$path,$method,['Authorization: Bearer '.google_token($flow),'Content-Type: application/json'],$body === null ? null : json_encode($body ?: new stdClass(),JSON_THROW_ON_ERROR));
}
function google_session(array &$flow): void {
    if (!empty($flow['session']['id'])) { try { google_api($flow,'sessions/'.rawurlencode($flow['session']['id']),'DELETE'); } catch (DomainException) {} }
    $session = google_api($flow,'sessions','POST',[]);
    if (empty($session['id']) || !str_starts_with($session['pickerUri'] ?? '', 'https://photos.google.com/')) throw new DomainException('Réponse Google Photos invalide.');
    $flow['session'] = $session; unset($flow['progress'],$flow['job']); save_google($flow);
}
function google_begin(bool $switch = false): never {
    if (!google_configured()) throw new DomainException('Configure Google Photos sur le serveur.');
    $flow = google_flow();
    if (($flow['progress']['status'] ?? '') === 'running') throw new DomainException('Attends la fin de l’import en cours.');
    if (!$switch && (!empty($flow['refreshToken']) || !empty($flow['token']))) { google_session($flow); back(null,'Ouvre Google Photos pour choisir tes médias.','imports'); }
    $verifier = rtrim(strtr(base64_encode(random_bytes(48)),'+/','-_'),'='); $state = bin2hex(random_bytes(32));
    save_google(['verifier'=>$verifier,'state'=>$state,'oauthExpires'=>time()+600,'adminHash'=>hash('sha256',session_id())]);
    $params = ['client_id'=>setting('GOOGLE_PHOTOS_CLIENT_ID'),'redirect_uri'=>SITE_URL.'/admin/google-photos/callback','response_type'=>'code','scope'=>GOOGLE_SCOPE,'state'=>$state,'code_challenge_method'=>'S256','code_challenge'=>rtrim(strtr(base64_encode(hash('sha256',$verifier,true)),'+/','-_'),'='),'access_type'=>'offline','prompt'=>$switch ? 'consent select_account' : 'consent'];
    header('Location: https://accounts.google.com/o/oauth2/v2/auth?'.http_build_query($params),true,303); exit;
}
function google_callback(): never {
    try {
        $flow = google_flow();
        if (isset($_GET['error'])) throw new DomainException('Connexion Google annulée ou refusée.');
        if (empty($flow['state']) || !is_string($_GET['state'] ?? null) || !hash_equals($flow['state'],$_GET['state']) || ($flow['oauthExpires'] ?? 0)<time() || !hash_equals($flow['adminHash'],hash('sha256',session_id())) || !is_string($_GET['code'] ?? null)) throw new DomainException('Autorisation Google invalide ou expirée. Recommence la connexion.');
        $token = google_token_exchange(['redirect_uri'=>SITE_URL.'/admin/google-photos/callback','grant_type'=>'authorization_code','code'=>$_GET['code'],'code_verifier'=>$flow['verifier']]);
        if (empty($token['access_token']) || !in_array(GOOGLE_SCOPE,explode(' ',$token['scope'] ?? ''),true)) throw new DomainException('Autorise la sélection de photos dans Google Photos.');
        $flow = ['token'=>$token['access_token'],'refreshToken'=>$token['refresh_token'] ?? null,'expires'=>time()+(int)($token['expires_in'] ?? 3600)];
        save_google($flow); google_session($flow); back(null,'Google Photos est connecté.','imports');
    } catch (DomainException $e) { back(null,'','imports',$e->getMessage()); }
}
function google_view(?array $flow = null): array {
    $flow ??= google_flow();
    return ['configured'=>google_configured(),'connected'=>!empty($flow['refreshToken']) || (!empty($flow['token']) && ($flow['expires'] ?? 0)>time()),'pickerUri'=>$flow['session']['pickerUri'] ?? '', 'ready'=>!empty($flow['session']['mediaItemsSet']),'progress'=>$flow['progress'] ?? null];
}
function google_start(): void {
    $flow = google_flow();
    if (($flow['progress']['status'] ?? '') === 'running') throw new DomainException('Un import est déjà en cours.');
    if (empty($flow['session']['id'])) throw new DomainException('Choisis des médias dans Google Photos avant l’import.');
    $flow['session'] = google_api($flow,'sessions/'.rawurlencode($flow['session']['id']));
    if (empty($flow['session']['mediaItemsSet'])) throw new DomainException('Termine la sélection dans Google Photos avant l’import.');
    $fallback = field('fallback_date'); if ($fallback !== '') require_date($fallback);
    $flow['progress'] = ['status'=>'running','total'=>0,'processed'=>0,'imported'=>0,'duplicates'=>0,'created'=>0,'failed'=>0,'errors'=>[],'selectedId'=>null,'message'=>''];
    $flow['job'] = ['fallback'=>$fallback,'items'=>[],'next'=>'','seen'=>[],'loaded'=>false]; save_google($flow);
}
function google_download(array $item, string $token): string {
    if (!in_array($item['type'] ?? '',['PHOTO','VIDEO'],true)) throw new DomainException('Choisis une photo ou une vidéo.');
    $video = $item['type'] === 'VIDEO';
    if ($video && ($item['mediaFile']['mediaFileMetadata']['videoMetadata']['processingStatus'] ?? '') !== 'READY') throw new DomainException('Cette vidéo n’est pas encore prête dans Google Photos. Réessaie après son traitement.');
    $url = $item['mediaFile']['baseUrl'] ?? ''; $parts = parse_url($url); $host = $parts['host'] ?? '';
    if (($parts['scheme'] ?? '') !== 'https' || isset($parts['user']) || isset($parts['pass']) || isset($parts['port']) || !($host === 'googleusercontent.com' || str_ends_with($host,'.googleusercontent.com'))) throw new DomainException('Adresse de téléchargement Google Photos invalide.');
    $tmp = tempnam(PRIVATE_DIR,'google-');
    try { google_http($url.'='.($video ? 'dv' : 'd'),'GET',['Authorization: Bearer '.$token],null,$tmp,($video ? 100 : 12)*1024*1024); return $tmp; }
    catch (Throwable $e) { unlink($tmp); throw $e; }
}
function google_tick(): array {
    $id = google_id(); if (!$id) return google_view();
    $lock = fopen(PRIVATE_DIR.'/google-'.$id.'.lock','c');
    if (!flock($lock,LOCK_EX|LOCK_NB)) { fclose($lock); return google_view(); }
    try {
        $flow = google_flow();
        if (($flow['progress']['status'] ?? '') !== 'running') {
            if (!empty($flow['session']['id']) && empty($flow['session']['mediaItemsSet'])) { $flow['session'] = google_api($flow,'sessions/'.rawurlencode($flow['session']['id'])); save_google($flow); }
            return google_view($flow);
        }
        $job =& $flow['job']; $progress =& $flow['progress'];
        try {
            if (!$job['items'] && (!$job['loaded'] || $job['next'] !== '')) {
                $params = ['sessionId'=>$flow['session']['id'],'pageSize'=>100];
                if ($job['next'] !== '') $params['pageToken'] = $job['next'];
                $page = google_api($flow,'mediaItems?'.http_build_query($params));
                $job['items'] = $page['mediaItems'] ?? []; $job['loaded'] = true; $next = $page['nextPageToken'] ?? '';
                if ($next !== '' && in_array($next,$job['seen'],true)) throw new DomainException('Pagination Google répétée. Relance la sélection.');
                if ($next !== '') $job['seen'][] = $next;
                $job['next'] = $next; $progress['total'] += count($job['items']); save_google($flow);
            }
            if ($job['items']) {
                $item = $job['items'][0]; $tmp = null;
                try {
                    if ($existing = duplicate('google',$item['id'])) throw new DuplicateMedia($existing);
                    $tmp = google_download($item,google_token($flow));
                    $media = process_media($tmp,$item['mediaFile']['filename'] ?? ($item['type'] === 'VIDEO' ? 'Google Photos.mp4' : 'Google Photos.jpg'));
                    $media['taken_at'] ??= taken_time($item['createTime'] ?? null,true);
                    $date = substr($media['taken_at'] ?? '',0,10) ?: $job['fallback'];
                    if (!$date) { remove_files($media['id']); throw new DomainException('Date absente. Renseigne une date de remplacement.'); }
                    $target = store_media($media,null,$date,$item['id']);
                    $progress['selectedId'] ??= $target['dayId']; $progress['created'] += (int)$target['created']; $progress['imported']++;
                } catch (DuplicateMedia $e) {
                    query('INSERT OR IGNORE INTO photo_sources(source,source_id,photo_id) VALUES (?,?,?)',['google',$item['id'],$e->photoId]); $progress['duplicates']++;
                } catch (DomainException $e) {
                    $progress['failed']++; if (count($progress['errors'])<20) $progress['errors'][] = '« '.mb_substr($item['mediaFile']['filename'] ?? 'Média',0,100).' » : '.$e->getMessage();
                } finally { if ($tmp && is_file($tmp)) unlink($tmp); }
                array_shift($job['items']); $progress['processed']++;
            }
            if (!$job['items'] && $job['loaded'] && $job['next'] === '') {
                $progress['status'] = 'done';
                if ($progress['failed'] === 0) { try { google_api($flow,'sessions/'.rawurlencode($flow['session']['id']),'DELETE'); } catch (DomainException) {} unset($flow['session']); }
                unset($flow['job']);
            }
        } catch (Throwable $e) {
            $flow['progress']['status'] = 'failed'; $flow['progress']['message'] = $e instanceof DomainException ? $e->getMessage() : 'Import interrompu. Recharge puis relance la sélection ; les doublons seront ignorés.';
            if (!$e instanceof DomainException) error_log('SereTiny Google: '.$e->getMessage());
        }
        save_google($flow); return google_view($flow);
    } finally { flock($lock,LOCK_UN); fclose($lock); }
}
