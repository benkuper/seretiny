<?php
declare(strict_types=1);

function action(string $name): never {
    require_admin(); check_csrf();
    switch ($name) {
        case 'logout':
            unset($_SESSION['admin_until'],$_SESSION['secret_hash']); session_regenerate_id(true); $_SESSION['csrf']=bin2hex(random_bytes(32)); go('/');
        case 'connectGooglePhotos': google_begin();
        case 'switchGooglePhotos': google_begin(true);
        case 'disconnectGooglePhotos':
            $flow = google_flow();
            if (($flow['progress']['status'] ?? '') === 'running') throw new DomainException('Attends la fin de l’import avant de déconnecter Google.');
            if (!empty($flow['session']['id'])) { try { google_api($flow,'sessions/'.rawurlencode($flow['session']['id']),'DELETE'); } catch (DomainException) {} }
            query('DELETE FROM php_google_flows WHERE id=?',[google_id()]); back(null,'Google Photos est déconnecté.','imports');
        case 'importGooglePhotos': google_start(); back(null,'Import démarré. Garde cette page ouverte pour le poursuivre.','imports');
        case 'createDay':
            $id = create_day(require_date(field('date')),field('title_fr',150) ?: 'Une journée à raconter'); back($id,'Journée créée.');
        case 'saveDay':
            $id = positive_id(); require_row('days',$id); require_date(field('date'));
            query('UPDATE days SET date=?,title_fr=?,title_en=?,body_fr=?,body_en=?,published=? WHERE id=?',[field('date'),field('title_fr',150),field('title_en',150),field('body_fr',8000),field('body_en',8000),field('published')==='on' ? 1 : 0,$id]); back($id,'Journée enregistrée.');
        case 'deleteDay':
            $id = positive_id(); require_row('days',$id);
            $ids = transaction(function () use ($id) { $ids = query('SELECT id FROM photos WHERE day_id=?',[$id])->fetchAll(PDO::FETCH_COLUMN); query('DELETE FROM days WHERE id=?',[$id]); return $ids; });
            foreach ($ids as $photo) remove_files($photo); back(null,'Journée supprimée.');
        case 'addChapter': case 'saveChapter':
            $id = $name === 'saveChapter' ? positive_id() : 0; if ($id) require_row('chapters',$id);
            $fr = field('title_fr',100); if (!$fr) throw new DomainException('Le nom du chapitre est obligatoire.'); $date = require_date(field('start_date'));
            if (query('SELECT 1 FROM chapters WHERE start_date=? AND id<>?',[$date,$id])->fetchColumn()) throw new DomainException('Un chapitre commence déjà à cette date.');
            if ($id) query('UPDATE chapters SET title_fr=?,title_en=?,start_date=? WHERE id=?',[$fr,field('title_en',100),$date,$id]);
            else query('INSERT INTO chapters(title_fr,title_en,start_date,sort_order) VALUES (?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM chapters))',[$fr,field('title_en',100),$date]);
            back(null,'Chapitre enregistré.','chapters');
        case 'savePhoto':
            edit_photos([field('id',50)],['date'=>field('date'),'caption_fr'=>field('caption_fr',500),'caption_en'=>field('caption_en',500)]); back(positive_id('return_to'),'Média enregistré.');
        case 'editLibraryPhoto':
            $edit = field('edit');
            if (!in_array($edit,['date','caption'],true)) throw new DomainException('Champ invalide.');
            edit_photos([field('id',50)],$edit === 'date' ? ['date'=>field('date')] : ['caption_fr'=>field('caption_fr',500)]);
            action_success(['photoUpdated'=>field('id',50)]);
        case 'deletePhoto':
            $id = field('id',50); require_row('photos',$id); query('DELETE FROM photos WHERE id=?',[$id]); remove_files($id);
            if (($_GET['view'] ?? '')==='photos') action_success(['photoDeleted'=>$id]);
            back(positive_id('day_id'),'Média supprimé.');
        case 'bulkDays':
            $ids = selection(); $decision = field('decision'); if (!in_array($decision,['publish','hide'],true)) throw new DomainException('Action invalide.');
            transaction(function () use ($ids,$decision) { foreach ($ids as $id) require_row('days',$id); foreach ($ids as $id) query('UPDATE days SET published=? WHERE id=?',[$decision==='publish' ? 1 : 0,$id]); }); back(null,count($ids).' journée(s) modifiée(s).');
        case 'bulkPhotos':
            $change = []; if (field('change_date')==='on') $change['date']=field('date');
            foreach (['caption_fr','caption_en'] as $key) if (field('change_'.$key)==='on') $change[$key]=field($key,500);
            $ids=selection(); edit_photos($ids,$change); back(null,count($ids).' média(s) modifié(s).','photos');
        case 'moderate': case 'bulkComments':
            $ids = $name==='moderate' ? [positive_id()] : selection(); $decision = field('decision');
            if (!in_array($decision,['approve','delete'],true)) throw new DomainException('Action invalide.');
            transaction(function () use ($ids,$decision) {
                foreach ($ids as $id) require_row('comments',$id,true);
                foreach ($ids as $id) query($decision==='approve' ? 'UPDATE comments SET approved=1 WHERE id=?' : 'DELETE FROM comments WHERE id=?',[$id]);
            }); back(null,count($ids).' commentaire(s) traité(s).','comments');
        case 'upload': case 'importPhotos':
            $files = upload_files(); $day = null; $destination = field('destination'); $capture = $name==='importPhotos' && $destination==='capture';
            if ($name==='upload') { $day=positive_id('day_id'); require_row('days',$day); }
            $date = $capture ? field('fallback_date') : ($destination ?: field('date'));
            if ($date !== '') require_date($date); elseif (!$capture) $date=date('Y-m-d');
            $imported=0; $duplicates=0; $created=0; $errors=[]; $selected=$day;
            foreach ($files as $file) {
                try {
                    $media=process_media($file['tmp'],$file['name'],$capture && !$date);
                    $target=store_media($media,$day,$capture ? (substr($media['taken_at'] ?? '',0,10) ?: $date) : $date);
                    $selected ??= $target['dayId']; $created+=(int)$target['created']; $imported++;
                } catch (DuplicateMedia) { $duplicates++; }
                catch (DomainException $e) { $errors[]='« '.mb_substr($file['name'],0,100).' » : '.$e->getMessage(); }
            }
            if (!$imported && !$duplicates) throw new DomainException('Aucun média importé. '.implode(' ',$errors));
            back($selected,"$imported média(s) importé(s), $created journée(s) créée(s), $duplicates doublon(s) ignoré(s).",'',implode(' ',$errors));
        default: throw new DomainException('Action inconnue.');
    }
}
function comments_endpoint(): never {
    check_origin();
    if (!str_starts_with($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) json_response(['error'=>'Format de requête invalide.'],415);
    $raw=file_get_contents('php://input',false,null,0,4001); if (strlen($raw)>4000) json_response(['error'=>'Message trop long.'],413);
    try { $value=json_decode($raw,true,32,JSON_THROW_ON_ERROR); } catch (JsonException) { json_response(['error'=>'Message invalide.'],400); }
    if (!is_array($value)) json_response(['error'=>'Message invalide.'],400);
    if (is_string($value['website'] ?? null) && trim($value['website'])!=='') json_response(['ok'=>true]);
    $id=$value['dayId'] ?? 0; $author=is_string($value['author'] ?? null) ? trim($value['author']) : ''; $body=is_string($value['message'] ?? null) ? trim($value['message']) : '';
    if (!is_int($id) || $id<1 || mb_strlen($author)<2 || mb_strlen($author)>60 || mb_strlen($body)<3 || mb_strlen($body)>1000) json_response(['error'=>'Nom (2–60 caractères) et commentaire (3–1 000 caractères) requis.'],400);
    $hash=hash_hmac('sha256',$_SERVER['REMOTE_ADDR'] ?? '',setting('SESSION_SECRET'));
    transaction(function () use ($id,$author,$body,$hash) {
        $day=require_row('days',$id);
        if (!$day['published'] || !query('SELECT 1 FROM photos WHERE day_id=?',[$id])->fetchColumn()) throw new DomainException('Journée introuvable.');
        $since=gmdate('Y-m-d\TH:i:s.000\Z',time()-3600);
        if ((int)query('SELECT COUNT(*) FROM comments WHERE ip_hash=? AND created_at>=?',[$hash,$since])->fetchColumn()>=3) throw new DomainException('Trop de commentaires envoyés récemment. Réessaie plus tard.');
        query('INSERT INTO comments(day_id,author,body,ip_hash,created_at) VALUES (?,?,?,?,?)',[$id,$author,$body,$hash,gmdate('Y-m-d\TH:i:s.000\Z')]);
    }); json_response(['ok'=>true]);
}
