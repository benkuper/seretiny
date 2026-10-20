import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function video(name, {date = '2023-05-01T08:00:00Z', format = 'mp4', audioOnly = false, cameraDate} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'seretiny-video-fixture-'));
  const path = join(directory, `clip.${format}`);
  const color = createHash('sha256').update(name).digest('hex').slice(0, 6);
  try {
    const input = audioOnly ? [] : ['-f', 'lavfi', '-i', `color=c=0x${color}:s=64x48:r=10`];
    const codecs = format === 'webm' ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
    await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', ...input,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', ...codecs,
      ...(date ? ['-metadata', `creation_time=${date}`] : []),
      ...(cameraDate ? ['-metadata', `com.apple.quicktime.creationdate=${cameraDate}`, '-movflags', 'use_metadata_tags'] : []), path],
      {windowsHide: true, timeout: 30_000});
    return {name, buffer: await readFile(path), type: format === 'webm' ? 'video/webm' : format === 'mov' ? 'video/quicktime' : 'video/mp4'};
  } finally {
    await unlink(path).catch(() => {});
    await rmdir(directory);
  }
}

export async function photo(name, originalDate, extra = {}, format = 'jpeg') {
  const color = createHash('sha256').update(name).digest('hex').slice(0, 6);
  let pipeline = sharp({create: {width: 24, height: 18, channels: 3, background: `#${color}`}});
  const fields = { ...extra };
  if (originalDate) fields.DateTimeOriginal = originalDate;
  if (Object.keys(fields).length) pipeline = pipeline.withExif({IFD2: fields});
  return { name, buffer: await pipeline.toFormat(format).toBuffer(), type: `image/${format}` };
}
