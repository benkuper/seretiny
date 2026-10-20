import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import { FFMPEG_PATH, FFPROBE_PATH } from '$app/env/private';
import { MEDIA_DIR, ORIGINALS_DIR, importedPhoto, DuplicatePhotoError, dateValid } from './db.js';
import { processPhoto, indexExistingPhotos, deletePhotoFiles } from './images.js';
import { localTakenAt } from './media-dates.js';

export const MAX_VIDEO_FILE = 100 * 1024 * 1024;
const run = promisify(execFile);

type Probe = {
  streams?: {codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; duration?: string;
    disposition?: {attached_pic?: number}; tags?: Record<string, string>}[];
  format?: {duration?: string; tags?: Record<string, string>};
};

async function videoTool(binary: string, args: string[], timeout: number) {
  try {
    return await run(binary, args, {timeout, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Import vidéo indisponible : installe FFmpeg et ffprobe sur le serveur.');
    }
    throw new Error('Vidéo illisible ou traitement trop long. Utilise un fichier MP4, MOV ou WebM de 10 minutes maximum.');
  }
}

function captureTime(probe: Probe) {
  const tags = {...probe.streams?.find(stream => stream.codec_type === 'video')?.tags, ...probe.format?.tags};
  const cameraDate = tags['com.apple.quicktime.creationdate'];
  if (cameraDate && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(cameraDate) &&
      dateValid(cameraDate.slice(0, 10)) && !Number.isNaN(Date.parse(cameraDate))) {
    return `${cameraDate.slice(0, 19)}.000`;
  }
  return localTakenAt(tags.creation_time);
}

export async function processMedia(file: File, {requireCaptureDate = false} = {}) {
  const header = Buffer.from(await file.slice(0, 16).arrayBuffer());
  const mp4 = header.toString('ascii', 4, 8) === 'ftyp';
  const webm = header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!mp4 && !webm) {
    if (file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(file.name)) throw new Error('Fichier vidéo invalide.');
    return processPhoto(file, {requireCaptureDate});
  }
  if (!file.size || file.size > MAX_VIDEO_FILE) throw new Error('Chaque vidéo doit faire entre 1 octet et 100 Mo.');
  const buffer = Buffer.from(await file.arrayBuffer());
  await indexExistingPhotos();
  const content_hash = createHash('sha256').update(buffer).digest('hex');
  const existing = importedPhoto({source: 'sha256', source_id: content_hash});
  if (existing) throw new DuplicatePhotoError(existing.id);
  const id = randomUUID();
  const extension = webm ? 'webm' : extname(file.name).toLowerCase() === '.mov' ? 'mov' : 'mp4';
  const source = join(ORIGINALS_DIR, `${id}.${extension}`);
  const output = join(MEDIA_DIR, `${id}.mp4`);
  // Explicit demuxers and local-only protocols keep uploaded playlists/network references out.
  const input = ['-protocol_whitelist', 'file,pipe', '-f', webm ? 'matroska' : 'mov', '-i', source];
  try {
    await writeFile(source, buffer);
    const result = await videoTool(FFPROBE_PATH, ['-v', 'error', ...input, '-show_format', '-show_streams', '-of', 'json'], 30_000);
    const probe: Probe = JSON.parse(result.stdout.toString('utf8'));
    const stream = probe.streams?.find(item => item.codec_type === 'video' && !item.disposition?.attached_pic);
    const duration = Number(probe.format?.duration ?? stream?.duration);
    if (!stream?.width || !stream.height || stream.width * stream.height > 70_000_000 ||
        !Number.isFinite(duration) || duration <= 0 || duration > 600) {
      throw new Error('Choisis une vidéo lisible de 10 minutes maximum.');
    }
    const taken_at = captureTime(probe);
    const capture_date = taken_at?.slice(0, 10) ?? null;
    if (requireCaptureDate && !capture_date) throw new Error('Date de prise de vue absente. Choisis une date de remplacement pour cette vidéo.');
    const audio = probe.streams?.find(item => item.codec_type === 'audio');
    const nativeMp4 = mp4 && stream.codec_name === 'h264' && stream.pix_fmt === 'yuv420p' &&
      (!audio || ['aac', 'mp3'].includes(audio.codec_name ?? ''));
    const codecs = nativeMp4 ? ['-c', 'copy'] : [
      '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-threads', '2',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
    await videoTool(FFMPEG_PATH, ['-nostdin', '-v', 'error', '-y', ...input,
      '-map', '0:V:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
      ...codecs, '-movflags', '+faststart', '-t', '600', output], 600_000);
    const poster = await videoTool(FFMPEG_PATH, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', output, '-vf', 'scale=1900:1500:force_original_aspect_ratio=decrease',
      '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], 30_000);
    const posterBuffer = poster.stdout;
    await sharp(posterBuffer).resize({width:1900,height:1500,fit:'inside',withoutEnlargement:true})
      .webp({quality:83}).toFile(join(MEDIA_DIR, `${id}.webp`));
    await sharp(posterBuffer).resize(500, 500, {fit:'cover',position:'attention'})
      .webp({quality:78}).toFile(join(MEDIA_DIR, `${id}_sm.webp`));
    return {id, original_name: file.name.slice(0,255), kind: 'video' as const, taken_at, capture_date, content_hash};
  } catch (error) {
    await deletePhotoFiles(id);
    throw error;
  }
}
