import type { PageServerLoad, Actions } from './$types';
import type { Cookies } from '@sveltejs/kit';
import { fail, redirect } from '@sveltejs/kit';
import { isAdmin, logout } from '#lib/server/auth.js';
import {
  chapters, days, pendingComments, createDay, updateDay, deleteDay,
  insertPhoto, moveAndEditPhoto, removePhoto, addChapter, editChapter, moderateComment,
  photoCount, getDay, dateValid, insertPhotoForDate, DuplicatePhotoError, importedPhoto, rememberPhotoSource,
  bulkPublishDays, bulkEditPhotos, bulkModerateComments, photoAccess
} from '#lib/server/db.js';
import { deletePhotoFiles, indexExistingTakenDates } from '#lib/server/images.js';
import { processMedia } from '#lib/server/videos.js';
import { localTakenAt } from '#lib/server/media-dates.js';
import type { Photo } from '#lib/types.js';
import { beginGooglePhotos, clearGooglePhotos, googlePhotosView, startGoogleSelection,
  downloadGooglePhoto, googlePhotoDate, googlePhotoTakenAt } from '#lib/server/google-photos.js';

function requireAuth(event: { cookies: Cookies }) {
  if (!isAdmin(event.cookies)) redirect(303, '/admin/login');
}
const field = (fd: FormData, name: string, max = 10000) => String(fd.get(name) ?? '').trim().slice(0,max);
function positiveId(fd: FormData, key='id') {
  const n = Number(fd.get(key));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
function selection(fd: FormData): string[] {
  const values = fd.getAll('ids');
  if (!values.length || values.length > 500 || values.some(value => typeof value !== 'string' || !value || value.length > 50)) {
    throw new Error('Sélectionne entre 1 et 500 éléments.');
  }
  return [...new Set(values as string[])];
}
function numericSelectionId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Sélection invalide.');
  return Number(value);
}
function back(id?: number, message?:string, warning?: string, view = id ? 'day' : 'days'): never {
  const qs = new URLSearchParams();
  qs.set('view', view);
  if (id) qs.set('day',String(id));
  if (message) qs.set('notice',message);
  if (warning) qs.set('warning',warning);
  redirect(303,`/admin?${qs.toString()}`);
}

export const load: PageServerLoad = async (event) => {
  requireAuth(event);
  await indexExistingTakenDates();
  const requestedView = event.url.searchParams.get('view');
  const view = requestedView && ['days', 'day', 'photos', 'imports', 'chapters', 'comments'].includes(requestedView)
    ? requestedView : event.url.searchParams.has('day') ? 'day' : 'days';
  return {
    view,
    days: days(false),
    chapters: chapters(),
    comments: pendingComments(),
    googlePhotos: googlePhotosView(event.cookies),
    selectedId: Number(event.url.searchParams.get('day') || '0'),
    notice: event.url.searchParams.get('notice') || '',
    warning: event.url.searchParams.get('warning') || ''
  };
};

export const actions: Actions = {
  editLibraryPhoto: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const id = field(fd, 'id', 50);
    const edit = field(fd, 'edit');
    try {
      if (edit === 'date') bulkEditPhotos([id], {date: field(fd, 'date')});
      else if (edit === 'caption') bulkEditPhotos([id], {caption_fr: field(fd, 'caption_fr', 500)});
      else throw new Error('Champ de photo invalide.');
    } catch (error) { return fail(400, {message: error instanceof Error ? error.message : 'Modification impossible.'}); }
    return {photoUpdated: id};
  },
  bulkDays: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    let count = 0;
    let decision: string;
    try {
      const ids = selection(fd).map(numericSelectionId);
      decision = field(fd, 'decision');
      if (decision !== 'publish' && decision !== 'hide') throw new Error('Choisis une action valide.');
      bulkPublishDays(ids, decision === 'publish' ? 1 : 0);
      count = ids.length;
    } catch (error) { return fail(400, {message: error instanceof Error ? error.message : 'Modification impossible.'}); }
    back(undefined, `${count} journée(s) ${decision === 'publish' ? 'avec affichage activé' : 'masquée(s)'}.`);
  },
  bulkPhotos: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    let count = 0;
    try {
      const ids = selection(fd);
      const change: {date?: string; caption_fr?: string; caption_en?: string} = {};
      if (fd.get('change_date') === 'on') change.date = field(fd, 'date');
      if (fd.get('change_caption_fr') === 'on') change.caption_fr = field(fd, 'caption_fr', 500);
      if (fd.get('change_caption_en') === 'on') change.caption_en = field(fd, 'caption_en', 500);
      if (!Object.keys(change).length) throw new Error('Coche au moins un champ à modifier.');
      bulkEditPhotos(ids, change);
      count = ids.length;
    } catch (error) { return fail(400, {message: error instanceof Error ? error.message : 'Modification impossible.'}); }
    back(undefined, `${count} média(s) modifié(s).`, undefined, 'photos');
  },
  bulkComments: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    let count = 0;
    try {
      const ids = selection(fd).map(numericSelectionId);
      const decision = field(fd, 'decision');
      if (decision !== 'approve' && decision !== 'delete') throw new Error('Choisis une action valide.');
      bulkModerateComments(ids, decision);
      count = ids.length;
    } catch (error) { return fail(400, {message: error instanceof Error ? error.message : 'Modération impossible.'}); }
    back(undefined, `${count} commentaire(s) traité(s).`, undefined, 'comments');
  },
  connectGooglePhotos: async (event) => {
    requireAuth(event);
    let url: string;
    try { url = await beginGooglePhotos(event.cookies); }
    catch (error) { return fail(400,{message: error instanceof Error ? error.message : 'Connexion Google Photos impossible.'}); }
    redirect(303, url, {external: ['https://accounts.google.com']});
  },
  switchGooglePhotos: async (event) => {
    requireAuth(event);
    let url: string;
    try { url = await beginGooglePhotos(event.cookies, {switchAccount: true}); }
    catch (error) { return fail(400,{message: error instanceof Error ? error.message : 'Connexion Google Photos impossible.'}); }
    redirect(303, url, {external: ['https://accounts.google.com']});
  },
  disconnectGooglePhotos: async (event) => {
    requireAuth(event);
    try { await clearGooglePhotos(event.cookies); }
    catch (error) { return fail(400,{message: error instanceof Error ? error.message : 'Déconnexion impossible.'}); }
    back(undefined, 'Sélection Google Photos terminée.', undefined, 'imports');
  },
  importGooglePhotos: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const fallbackDate = field(fd,'fallback_date',10);
    if (fallbackDate && !dateValid(fallbackDate)) return fail(400,{message:'Choisis une date de remplacement valide.'});
    try {
      await startGoogleSelection(event.cookies, async (photos, token, progress, ensureActive) => {
        for (const photo of photos) {
          ensureActive();
          const source = {source: 'google' as const, source_id: photo.id};
          try {
            if (importedPhoto(source)) { progress.duplicates++; continue; }
            const file = await downloadGooglePhoto(photo, await token());
            const result = await processMedia(file);
            try {
              const date = result.capture_date || googlePhotoDate(photo.createTime) || fallbackDate;
              if (!date) throw new Error('Date absente. Renseigne une date de remplacement.');
              const target = insertPhotoForDate({...result, taken_at: result.taken_at || googlePhotoTakenAt(photo.createTime)}, date,
                [source, {source: 'sha256', source_id: result.content_hash}]);
              progress.selectedId ??= target.dayId;
              if (target.created) progress.created++;
            } catch (error) {
              await deletePhotoFiles(result.id);
              throw error;
            }
            progress.imported++;
          } catch (error) {
            if (error instanceof DuplicatePhotoError) {
              if (error.photoId) rememberPhotoSource(error.photoId, source);
              progress.duplicates++;
              continue;
            }
            progress.failed++;
            if (progress.errors.length < 20) progress.errors.push(`« ${(photo.mediaFile.filename || 'Photo').slice(0,100)} » : ${error instanceof Error ? error.message : 'Import impossible.'}`);
          } finally { progress.processed++; }
        }
      });
    } catch (error) { return fail(400,{message: error instanceof Error ? error.message : 'Import Google Photos impossible.'}); }
    back(undefined, 'Import Google Photos démarré. Tu peux suivre sa progression ci-dessous.', undefined, 'imports');
  },
  importPhotos: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const uploaded = fd.getAll('photos').filter((item): item is File => item instanceof File && item.size > 0);
    if (uploaded.length < 1 || uploaded.length > 8) return fail(400,{message:'Choisis entre 1 et 8 fichiers à la fois.'});
    const destination = field(fd, 'destination');
    const byCaptureDate = destination === 'capture';
    const requestedDate = destination && !byCaptureDate ? destination : field(fd, byCaptureDate ? 'fallback_date' : 'date');
    if (requestedDate && !dateValid(requestedDate)) return fail(400,{message:'Choisis une date valide.'});
    const targetDate = requestedDate || (byCaptureDate ? '' : localTakenAt(new Date().toISOString())!.slice(0, 10));
    let imported = 0;
    let duplicates = 0;
    let created = 0;
    let fallbackCount = 0;
    let selectedId: number | undefined;
    const dayIds = new Set<number>();
    const errors: string[] = [];
    for (const photo of uploaded) {
      try {
        const result = await processMedia(photo, {requireCaptureDate: byCaptureDate && !targetDate});
        try {
          const target = insertPhotoForDate(result, (byCaptureDate && result.capture_date) || targetDate,
            [{source: 'sha256', source_id: result.content_hash}]);
          selectedId ??= target.dayId;
          dayIds.add(target.dayId);
          if (target.created) created++;
        } catch (error) {
          await deletePhotoFiles(result.id);
          throw error;
        }
        imported++;
        if (byCaptureDate && !result.capture_date) fallbackCount++;
      } catch (error) {
        if (error instanceof DuplicatePhotoError) { duplicates++; continue; }
        errors.push(`« ${photo.name.slice(0,100)} » : ${error instanceof Error ? error.message : 'Import impossible.'}`);
      }
    }
    if (!imported && !duplicates) return fail(400,{message:`Aucun média importé. ${errors.join(' ')}`});
    const summary = `${imported} média(s) importé(s) dans ${dayIds.size} journée(s), dont ${created} nouvelle(s) avec affichage activé. ${duplicates} doublon(s) ignoré(s).`;
    back(selectedId, summary + (fallbackCount ? ` Date de remplacement utilisée pour ${fallbackCount} média(s).` : ''),
      errors.length ? `${errors.length} média(s) non importé(s). Réessaie uniquement ces fichiers. ${errors.join(' ')}` : undefined);
  },
  createDay: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const date = field(fd,'date',10);
    if (!dateValid(date)) return fail(400,{message:'Choisis une date valide.'});
    let id: number;
    try {
      id = createDay(date,field(fd,'title_fr',150)||'Une journée à raconter');
    } catch { return fail(400,{message:'Une journée existe déjà à cette date.'}); }
    back(id,'Journée créée. Elle sera visible sur le site dès l’ajout de photos ou vidéos.');
  },
  saveDay: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const id = positiveId(fd);
    if (!getDay(id)) return fail(404,{message:'Journée introuvable.'});
    try {
      updateDay(id,{
        date: field(fd,'date',10),
        title_fr: field(fd,'title_fr',150), title_en: field(fd,'title_en',150),
        body_fr: field(fd,'body_fr',8000), body_en: field(fd,'body_en',8000),
        published: fd.get('published') === 'on' ? 1 : 0
      });
    } catch(error) {return fail(400,{message:error instanceof Error?error.message:'Impossible de sauvegarder.'});}
    back(id,'Journée enregistrée.');
  },
  upload: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const dayId = positiveId(fd,'day_id');
    if (!getDay(dayId)) return fail(404,{message:'Journée introuvable.'});
    const uploaded = fd.getAll('photos').filter((item): item is File => item instanceof File && item.size>0);
    if (uploaded.length < 1 || uploaded.length > 8) return fail(400,{message:'Choisis entre 1 et 8 fichiers à la fois.'});
    let imported = 0;
    let duplicates = 0;
    for (const photo of uploaded) {
      try {
        const result = await processMedia(photo);
        const value: Photo = {
          id: result.id, day_id: dayId, taken_at: result.taken_at, kind: result.kind, caption_fr: '', caption_en: '',
          sort_order: photoCount(dayId), original_name: result.original_name
        };
        try { insertPhoto(value, [{source: 'sha256', source_id: result.content_hash}]); }
        catch(error) { await deletePhotoFiles(result.id); throw error; }
        imported++;
      } catch(error) {
        if (error instanceof DuplicatePhotoError) { duplicates++; continue; }
        return fail(400,{message:`${imported} média(s) importé(s), puis erreur sur « ${photo.name} » : ${error instanceof Error?error.message:'Format invalide'}. Recharge la page.`});
      }
    }
    back(dayId,`${imported} média(s) importé(s), ${duplicates} doublon(s) ignoré(s). Tu peux maintenant ajouter leurs légendes.`);
  },
  savePhoto: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const id = field(fd,'id',50);
    const returnTo = positiveId(fd,'return_to');
    try {
      moveAndEditPhoto(id,field(fd,'date',10),field(fd,'caption_fr',500),field(fd,'caption_en',500));
    } catch(error) {return fail(400,{message:error instanceof Error?error.message:'Erreur de photo.'});}
    back(returnTo,'Photo enregistrée. Si la date était nouvelle, une journée visible sur le site a été créée.');
  },
  deletePhoto: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const id = field(fd,'id',50);
    const dayId = positiveId(fd,'day_id');
    if (!photoAccess(id)) return fail(404, {message: 'Photo introuvable.'});
    removePhoto(id);
    await deletePhotoFiles(id);
    if (event.url.searchParams.get('view') === 'photos') return {photoDeleted: id};
    back(dayId,'Photo supprimée.');
  },
  deleteDay: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const id = positiveId(fd);
    const photos = deleteDay(id);
    await Promise.allSettled(photos.map(deletePhotoFiles));
    back(undefined,'Journée supprimée.');
  },
  addChapter: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const fr = field(fd,'title_fr',100);
    if (!fr) return fail(400,{message:'Le nom du chapitre est obligatoire.'});
    try { addChapter(fr,field(fd,'title_en',100),field(fd,'start_date')); }
    catch (error) { return fail(400,{message: error instanceof Error ? error.message : 'Impossible d’ajouter le chapitre.'}); }
    back(undefined,'Chapitre ajouté.', undefined, 'chapters');
  },
  saveChapter: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const id = positiveId(fd);
    const fr = field(fd,'title_fr',100);
    if (!chapters().some(chapter => chapter.id === id)) return fail(404,{message:'Chapitre introuvable.'});
    if (!fr) return fail(400,{message:'Le nom du chapitre est obligatoire.'});
    try { editChapter(id,fr,field(fd,'title_en',100),field(fd,'start_date')); }
    catch (error) { return fail(400,{message: error instanceof Error ? error.message : 'Impossible de modifier le chapitre.'}); }
    back(undefined,'Chapitre modifié.', undefined, 'chapters');
  },
  moderate: async (event) => {
    requireAuth(event);
    const fd = await event.request.formData();
    const id = positiveId(fd);
    const decision = field(fd,'decision',20);
    if (decision !== 'approve' && decision !== 'delete') return fail(400,{message:'Action invalide.'});
    moderateComment(id,decision);
    back(undefined,'Commentaire traité.', undefined, 'comments');
  },
  logout: async (event) => {
    requireAuth(event);
    logout(event.cookies);
    redirect(303,'/');
  }
};
