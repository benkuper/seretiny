<?php
declare(strict_types=1);

final class DuplicateMedia extends DomainException { public function __construct(public string $photoId) { parent::__construct('Média déjà importé.'); } }
function duplicate(string $source, string $id): ?string {
    $value = query('SELECT photo_id FROM photo_sources WHERE source=? AND source_id=?', [$source, $id])->fetchColumn(); return $value === false ? null : $value;
}
function taken_time(?string $value, bool $utc = false): ?string {
    if (!$value) return null;
    try {
        if ($utc) return (new DateTimeImmutable($value))->setTimezone(new DateTimeZone(date_default_timezone_get()))->format('Y-m-d\TH:i:s.v');
        if (preg_match('/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/', $value, $m) && valid_date("$m[1]-$m[2]-$m[3]") && (int)$m[4]<24 && (int)$m[5]<60 && (int)$m[6]<60) return "$m[1]-$m[2]-$m[3]T$m[4]:$m[5]:$m[6].000";
    } catch (Throwable) {}
    return null;
}
function run_tool(string $binary, array $args, int $timeout = 120): string {
    if (!is_executable($binary)) throw new DomainException('Le traitement vidéo est indisponible sur le serveur.');
    $pipes = []; $process = proc_open(array_merge([$binary], $args), [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes);
    if (!is_resource($process)) throw new DomainException('Traitement vidéo indisponible.');
    fclose($pipes[0]); stream_set_blocking($pipes[1], false); stream_set_blocking($pipes[2], false);
    $output = ''; $error = ''; $start = microtime(true); $exit = -1;
    try {
        do {
            $output .= stream_get_contents($pipes[1]); $error .= stream_get_contents($pipes[2]);
            if (strlen($output) + strlen($error) > 16 * 1024 * 1024 || microtime(true) - $start > $timeout) throw new DomainException('Traitement vidéo trop long. Choisis un fichier plus court.');
            $status = proc_get_status($process);
            if (!$status['running']) { $exit = $status['exitcode']; break; }
            usleep(20000);
        } while (true);
        $output .= stream_get_contents($pipes[1]);
        if ($exit !== 0) throw new DomainException('Vidéo illisible. Utilise MP4, MOV ou WebM, 10 minutes maximum.');
        return $output;
    } finally {
        $status = proc_get_status($process); if ($status['running']) proc_terminate($process, 9);
        fclose($pipes[1]); fclose($pipes[2]); proc_close($process);
    }
}
function image_variant(GdImage $image, string $path, bool $thumb): void {
    $w = imagesx($image); $h = imagesy($image);
    if ($thumb) {
        $size = min($w, $h); $sx = (int)(($w-$size)/2); $sy = (int)(($h-$size)/2);
        $target = imagecreatetruecolor(500, 500); imagealphablending($target, false); imagesavealpha($target, true);
        imagecopyresampled($target, $image, 0, 0, $sx, $sy, 500, 500, $size, $size);
    } else {
        $scale = min(1, 1900/$w, 1500/$h); $tw = max(1,(int)round($w*$scale)); $th = max(1,(int)round($h*$scale));
        $target = imagecreatetruecolor($tw, $th); imagealphablending($target, false); imagesavealpha($target, true);
        imagecopyresampled($target, $image, 0, 0, 0, 0, $tw, $th, $w, $h);
    }
    if (!imagewebp($target, $path, $thumb ? 78 : 83)) throw new RuntimeException('Écriture de l’image impossible.');
}
function process_media(string $tmp, string $name, bool $requireCapture = false): array {
    $size = filesize($tmp); $mime = (new finfo(FILEINFO_MIME_TYPE))->file($tmp);
    $types = ['image/jpeg'=>'jpeg','image/png'=>'png','image/webp'=>'webp','image/avif'=>'avif'];
    $video = in_array($mime, ['video/mp4','video/quicktime','video/webm','video/x-matroska','application/mp4'], true);
    if (!$video && !isset($types[$mime])) throw new DomainException('Format non pris en charge. Utilise JPG, PNG, WebP, AVIF, MP4, MOV ou WebM.');
    if (!$size || $size > ($video ? 100 : 12)*1024*1024) throw new DomainException($video ? 'Chaque vidéo doit faire 100 Mo maximum.' : 'Chaque photo doit faire 12 Mo maximum.');
    $hash = hash_file('sha256', $tmp); $existing = duplicate('sha256', $hash);
    if ($existing) throw new DuplicateMedia($existing);
    $id = bin2hex(random_bytes(16)); $extension = $video ? ($mime === 'video/quicktime' ? 'mov' : (str_contains($mime, 'webm') || str_contains($mime, 'matroska') ? 'webm' : 'mp4')) : $types[$mime];
    $original = DATA_DIR . "/originals/$id.$extension"; $large = DATA_DIR . "/media/$id.webp"; $thumb = DATA_DIR . "/media/{$id}_sm.webp";
    $taken = null;
    try {
        if (!$video) {
            $info = @getimagesize($tmp);
            if (!$info || $info[0]*$info[1] > 24000000) throw new DomainException('Image invalide ou trop grande (24 mégapixels maximum).');
            $exif = $mime === 'image/jpeg' ? @exif_read_data($tmp, null, true) : [];
            $taken = taken_time($exif['EXIF']['DateTimeOriginal'] ?? $exif['EXIF']['DateTimeDigitized'] ?? null);
            if ($requireCapture && !$taken) throw new DomainException('Date de prise de vue absente. Choisis une date de remplacement.');
            $image = match ($mime) {
                'image/jpeg' => @imagecreatefromjpeg($tmp), 'image/png' => @imagecreatefrompng($tmp),
                'image/webp' => @imagecreatefromwebp($tmp), 'image/avif' => @imagecreatefromavif($tmp)
            };
            if (!$image) throw new DomainException('Fichier image invalide.');
            $orientation = (int)($exif['IFD0']['Orientation'] ?? 1);
            if (in_array($orientation, [2,4,5,7], true)) imageflip($image, IMG_FLIP_HORIZONTAL);
            $angle = match ($orientation) {3,4 => 180,5,6 => -90,7,8 => 90,default => 0};
            if ($angle) $image = imagerotate($image, $angle, 0);
            image_variant($image, $large, false); image_variant($image, $thumb, true);
            if (!copy($tmp, $original)) throw new RuntimeException('Écriture de l’original impossible.');
        } else {
            if (!copy($tmp, $original)) throw new RuntimeException('Écriture de l’original impossible.');
            $ffmpeg = setting('FFMPEG_PATH', PRIVATE_DIR . '/bin/ffmpeg'); $ffprobe = setting('FFPROBE_PATH', PRIVATE_DIR . '/bin/ffprobe');
            $input = ['-protocol_whitelist','file,pipe','-f',$extension === 'webm' ? 'matroska' : 'mov','-i',$original];
            $probe = json_decode(run_tool($ffprobe, array_merge(['-v','error'], $input, ['-show_format','-show_streams','-of','json']), 30), true, 512, JSON_THROW_ON_ERROR);
            $stream = null; $audio = null;
            foreach ($probe['streams'] ?? [] as $candidate) {
                if (($candidate['codec_type'] ?? '') === 'video' && empty($candidate['disposition']['attached_pic']) && !$stream) $stream = $candidate;
                if (($candidate['codec_type'] ?? '') === 'audio' && !$audio) $audio = $candidate;
            }
            $duration = (float)($probe['format']['duration'] ?? $stream['duration'] ?? 0);
            if (!$stream || $duration <= 0 || $duration > 600 || ($stream['width'] ?? 0)*($stream['height'] ?? 0) > 70000000) throw new DomainException('Choisis une vidéo lisible de 10 minutes maximum.');
            $tags = array_merge($stream['tags'] ?? [], $probe['format']['tags'] ?? []);
            $taken = taken_time($tags['com.apple.quicktime.creationdate'] ?? null) ?? taken_time($tags['creation_time'] ?? null, true);
            if ($requireCapture && !$taken) throw new DomainException('Date de prise de vue absente. Choisis une date de remplacement.');
            $native = $stream['codec_name'] === 'h264' && ($stream['pix_fmt'] ?? '') === 'yuv420p' && (!$audio || in_array($audio['codec_name'], ['aac','mp3'], true));
            $output = DATA_DIR . "/media/$id.mp4";
            $codecs = $native ? ['-c','copy'] : ['-vf',"scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",'-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','128k','-ac','2'];
            run_tool($ffmpeg, array_merge(['-nostdin','-v','error','-y'], $input, ['-map','0:V:0','-map','0:a:0?','-map_metadata','-1','-map_chapters','-1'], $codecs, ['-movflags','+faststart','-t','600',$output]), 160);
            $png = run_tool($ffmpeg, ['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',$output,'-vf','scale=1900:1500:force_original_aspect_ratio=decrease','-frames:v','1','-threads','1','-f','image2pipe','-c:v','png','pipe:1'], 30);
            $image = @imagecreatefromstring($png); if (!$image) throw new DomainException('Miniature vidéo illisible.');
            image_variant($image, $large, false); image_variant($image, $thumb, true);
        }
        return ['id'=>$id,'original_name'=>mb_substr($name,0,255),'taken_at'=>$taken,'kind'=>$video ? 'video' : 'photo','hash'=>$hash];
    } catch (Throwable $e) { remove_files($id); throw $e; }
}
function store_media(array $media, ?int $day, string $date, ?string $googleId = null): array {
    try {
        return transaction(function () use ($media, $day, $date, $googleId) {
            if ($existing = duplicate('sha256', $media['hash'])) throw new DuplicateMedia($existing);
            if ($googleId && ($existing = duplicate('google', $googleId))) throw new DuplicateMedia($existing);
            $target = $day ? ['dayId'=>$day,'created'=>false] : day_for_date($date);
            $order = (int)query('SELECT COALESCE(MAX(sort_order),-1)+1 FROM photos WHERE day_id=?', [$target['dayId']])->fetchColumn();
            query('INSERT INTO photos(id,day_id,taken_at,kind,sort_order,original_name) VALUES (?,?,?,?,?,?)', [$media['id'],$target['dayId'],$media['taken_at'],$media['kind'],$order,$media['original_name']]);
            query('INSERT INTO photo_sources(source,source_id,photo_id) VALUES (?,?,?)', ['sha256',$media['hash'],$media['id']]);
            if ($googleId) query('INSERT INTO photo_sources(source,source_id,photo_id) VALUES (?,?,?)', ['google',$googleId,$media['id']]);
            return $target;
        });
    } catch (Throwable $e) { remove_files($media['id']); throw $e; }
}
function upload_files(): array {
    $files = $_FILES['photos'] ?? null;
    if (!$files || !is_array($files['name'] ?? null) || count($files['name']) < 1 || count($files['name']) > 8) throw new DomainException('Choisis entre 1 et 8 fichiers (120 Mo maximum par envoi).');
    $total = 0; $result = [];
    foreach ($files['name'] as $i => $name) {
        if (!is_string($name) || !is_string($files['tmp_name'][$i] ?? null) || $files['error'][$i] !== UPLOAD_ERR_OK || !is_uploaded_file($files['tmp_name'][$i])) throw new DomainException('Envoi incomplet ou fichier trop volumineux. Réessaie avec moins de fichiers.');
        $total += $files['size'][$i]; $result[] = ['name'=>$name,'tmp'=>$files['tmp_name'][$i]];
    }
    if ($total > 120*1024*1024) throw new DomainException('Maximum 120 Mo par envoi.');
    return $result;
}
function serve_media(string $id, string $variant): never {
    $row = query('SELECT p.kind,d.published FROM photos p JOIN days d ON d.id=p.day_id WHERE p.id=?', [$id])->fetch();
    if (!$row || (!$row['published'] && !admin()) || !in_array($variant,['thumb','large','video'],true) || ($variant === 'video' && $row['kind'] !== 'video')) { http_response_code(404); exit; }
    $path = DATA_DIR . '/media/' . $id . match ($variant) {'thumb'=>'_sm.webp','large'=>'.webp','video'=>'.mp4'};
    if (!is_file($path)) { http_response_code(404); exit; }
    $size = filesize($path); $start = 0; $end = $size-1;
    header('Content-Type: ' . ($variant === 'video' ? 'video/mp4' : 'image/webp'));
    header('Cache-Control: private, no-store'); header('X-Content-Type-Options: nosniff'); header('Accept-Ranges: bytes');
    if ($variant === 'video' && isset($_SERVER['HTTP_RANGE'])) {
        $range = $_SERVER['HTTP_RANGE'];
        if (!preg_match('/^bytes=(\d*)-(\d*)$/D', $range, $m) || ($m[1] === '' && $m[2] === '')) { http_response_code(416); header("Content-Range: bytes */$size"); exit; }
        if ($m[1] === '') $start = max(0,$size-(int)$m[2]);
        else { $start = (int)$m[1]; if ($m[2] !== '') $end = min($end,(int)$m[2]); }
        if ($start > $end || $start >= $size) { http_response_code(416); header("Content-Range: bytes */$size"); exit; }
        http_response_code(206); header("Content-Range: bytes $start-$end/$size");
    }
    $length = $end-$start+1; header('Content-Length: ' . $length); session_write_close();
    if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') {
        $file = fopen($path,'rb'); fseek($file,$start);
        while ($length > 0 && !feof($file) && !connection_aborted()) { $chunk = fread($file,min(65536,$length)); echo $chunk; $length -= strlen($chunk); }
        fclose($file);
    }
    exit;
}
