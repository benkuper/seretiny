import { photo, video } from '../tests/fixtures.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const directory = 'dist-php/.private/test-fixtures';
await mkdir(directory, {recursive: true});
for (const file of [await photo('camera.jpg', '2023:05:01 08:30:00'), await photo('undated.png', null, {}, 'png'), await video('clip.mp4')]) {
  await writeFile(`${directory}/${file.name}`, file.buffer);
}
