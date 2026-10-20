import { createHash } from 'node:crypto';
import sharp from 'sharp';

export async function photo(name, originalDate, extra = {}, format = 'jpeg') {
  const color = createHash('sha256').update(name).digest('hex').slice(0, 6);
  let pipeline = sharp({create: {width: 24, height: 18, channels: 3, background: `#${color}`}});
  const fields = { ...extra };
  if (originalDate) fields.DateTimeOriginal = originalDate;
  if (Object.keys(fields).length) pipeline = pipeline.withExif({IFD2: fields});
  return { name, buffer: await pipeline.toFormat(format).toBuffer(), type: `image/${format}` };
}
