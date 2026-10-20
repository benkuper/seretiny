import Database from 'better-sqlite3';
import { mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve(process.env.DATA_DIR || './data');
const destination = resolve('dist-php/.private/initial-data');
await mkdir(destination, {recursive: true});
const db = new Database(`${source}/seretiny.sqlite`, {readonly: true});
await db.backup(`${destination}/seretiny.sqlite`);
db.close();
for (const directory of ['media', 'originals']) await cp(`${source}/${directory}`, `${destination}/${directory}`, {recursive: true});
console.log('Consistent SQLite backup and media copied for initial deployment. Local data preserved.');
