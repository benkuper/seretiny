import sharp from 'sharp';
import exifReader from 'exif-reader';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { MEDIA_DIR, ORIGINALS_DIR, importedPhoto, rememberPhotoSource, unhashedPhotos, DuplicatePhotoError,
  photosWithoutTakenDate, rememberPhotoTakenAt } from './db.js';

export const MAX_FILE = 12 * 1024 * 1024;
const FORMATS = new Set(['jpeg','png','webp','avif']);

let hashingExisting: Promise<void> | undefined;
export function indexExistingPhotos() {
  return hashingExisting ??= (async () => {
    for (const photo of unhashedPhotos()) {
      for (const extension of FORMATS) {
        let buffer: Buffer;
        try { buffer = await readFile(join(ORIGINALS_DIR, `${photo.id}.${extension}`)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        rememberPhotoSource(photo.id, {source: 'sha256', source_id: createHash('sha256').update(buffer).digest('hex')});
        const info = await sharp(buffer).metadata().catch(() => null);
        const takenAt = captureTime(info?.exif);
        if (takenAt) rememberPhotoTakenAt(photo.id, takenAt);
        break;
      }
    }
  })().catch(error => { hashingExisting = undefined; throw error; });
}

let indexingTakenDates: Promise<void> | undefined;
export function indexExistingTakenDates() {
  return indexingTakenDates ??= (async () => {
    for (const photo of photosWithoutTakenDate()) {
      for (const extension of FORMATS) {
        let info: sharp.Metadata;
        try { info = await sharp(join(ORIGINALS_DIR, `${photo.id}.${extension}`)).metadata(); }
        catch { continue; } // Missing or damaged originals keep the display-date fallback.
        const takenAt = captureTime(info.exif);
        if (takenAt) rememberPhotoTakenAt(photo.id, takenAt);
        break;
      }
    }
  })().catch(error => { indexingTakenDates = undefined; throw error; });
}

function captureTime(exif?: Buffer): string | null {
  if (!exif) return null;
  try {
    const metadata = exifReader(exif);
    // exif-reader represents the camera's local time as UTC. Keep that calendar
    // day, including near midnight, regardless of the server's time zone.
    for (const date of [metadata.Photo?.DateTimeOriginal, metadata.Photo?.DateTimeDigitized]) {
      if (date instanceof Date && !Number.isNaN(date.getTime()) && date.getUTCFullYear() > 0) {
        return date.toISOString().slice(0, -1);
      }
    }
  } catch {
    // Damaged or missing EXIF must not prevent a manual import.
  }
  return null;
}

export async function processPhoto(file: File, { requireCaptureDate = false } = {}) {
  if (file.size === 0 || file.size > MAX_FILE) throw new Error('Chaque photo doit faire entre 1 octet et 12 Mo.');
  const buffer = Buffer.from(await file.arrayBuffer());
  await indexExistingPhotos();
  const content_hash = createHash('sha256').update(buffer).digest('hex');
  const existing = importedPhoto({source: 'sha256', source_id: content_hash});
  if (existing) throw new DuplicatePhotoError(existing.id);
  let info: sharp.Metadata;
  try { info = await sharp(buffer, {limitInputPixels: 70_000_000}).metadata(); }
  catch { throw new Error('Fichier image invalide.'); }
  // libvips reports AVIF as HEIF with AV1 compression; HEIC stays unsupported.
  const format = info.format === 'heif' && info.compression === 'av1' ? 'avif' : info.format;
  if (!format || !FORMATS.has(format)) {
    throw new Error('Format non pris en charge. Utilise JPG, PNG, WebP ou AVIF.');
  }
  const taken_at = captureTime(info.exif);
  const capture_date = taken_at?.slice(0, 10) ?? null;
  if (requireCaptureDate && !capture_date) {
    throw new Error('Date de prise de vue absente ou illisible. Choisis une date de remplacement pour cette image.');
  }
  const id = randomUUID();
  const source = join(ORIGINALS_DIR, `${id}.${format}`);
  const large = join(MEDIA_DIR, `${id}.webp`);
  const small = join(MEDIA_DIR, `${id}_sm.webp`);
  try {
    await writeFile(source, buffer);
    await sharp(buffer, {limitInputPixels: 70_000_000}).rotate()
      .resize({width:1900,height:1500,fit:'inside',withoutEnlargement:true})
      .webp({quality:83,effort:4}).toFile(large);
    await sharp(buffer, {limitInputPixels: 70_000_000}).rotate()
      .resize({width:500,height:500,fit:'cover',position:'attention'})
      .webp({quality:78,effort:4}).toFile(small);
    return {id, original_name: file.name.slice(0,255), kind: 'photo' as const, taken_at, capture_date, content_hash};
  } catch (err) {
    await Promise.allSettled([unlink(source),unlink(large),unlink(small)]);
    throw err;
  }
}

export async function deletePhotoFiles(id: string) {
  const filenames = [`${id}.webp`,`${id}_sm.webp`,`${id}.mp4`];
  await Promise.allSettled(filenames.map(file=>unlink(join(MEDIA_DIR,file))));
  for (const extension of ['jpeg','png','webp','avif','mp4','mov','webm']) {
    await unlink(join(ORIGINALS_DIR,`${id}.${extension}`)).catch(()=>{});
  }
}
