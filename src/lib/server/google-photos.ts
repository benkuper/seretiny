import { createHash, randomBytes } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { GOOGLE_PHOTOS_CLIENT_ID, GOOGLE_PHOTOS_CLIENT_SECRET, GOOGLE_PHOTOS_REDIRECT_URI } from '$app/env/private';
import { adminSessionKey, isAdmin } from './auth.js';
import { dateValid } from './db.js';
import { MAX_FILE } from './images.js';
import { MAX_VIDEO_FILE } from './videos.js';
import { localTakenAt } from './media-dates.js';
import { exchangeGoogleCode, readGoogleResponse } from './google-http.js';
import type { GoogleImportProgress } from '#lib/types.js';
import { storeGoogleConnection, restoreGoogleConnection, removeGoogleConnection } from './google-connection-store.js';

const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const API = 'https://photospicker.googleapis.com/v1';
const COOKIE = 'seretiny_google_photos';
const CONNECTION_AGE = 30 * 24 * 60 * 60;
type PickerSession = {id: string; pickerUri: string; mediaItemsSet?: boolean; expireTime?: string;
  pollingConfig?: {pollInterval?: string; timeoutIn?: string}};
type GoogleFlow = { id: string; owner: string; state: string; verifier: string; expires: number; connectionExpires: number;
  token?: string; refreshToken?: string; session?: PickerSession; importing: boolean; nextPoll: number;
  progress?: GoogleImportProgress;
  refreshing?: Promise<string>; selecting?: Promise<void> };
export type GooglePhoto = { id: string; createTime?: string; type: string;
  mediaFile: {baseUrl: string; mimeType: string; filename: string;
    mediaFileMetadata?: {videoMetadata?: {processingStatus?: string}}} };

// Keep active jobs across development hot reloads. Persist credentials encrypted
// for full server restarts; only opaque connection IDs go into browser cookies.
const runtime = globalThis as typeof globalThis & {__seretinyGoogleFlows?: Map<string, GoogleFlow>};
const flows = runtime.__seretinyGoogleFlows ??= new Map<string, GoogleFlow>();

function saveFlow(flow: GoogleFlow) {
  const {refreshing: _refreshing, selecting: _selecting, ...saved} = flow;
  storeGoogleConnection(flow.id, saved, flow.connectionExpires);
}

export function googlePhotosConfigured() {
  return !!(GOOGLE_PHOTOS_CLIENT_ID && GOOGLE_PHOTOS_CLIENT_SECRET && GOOGLE_PHOTOS_REDIRECT_URI);
}

function flowFor(cookies: Cookies) {
  if (!isAdmin(cookies)) return;
  const id = cookies.get(COOKIE) || '';
  if (!id) return;
  let flow = flows.get(id);
  if (!flow) {
    flow = restoreGoogleConnection<GoogleFlow>(id);
    if (flow) {
      flow.id = id;
      flow.importing = false;
      if (flow.progress?.status === 'running') {
        flow.progress.status = 'failed';
        flow.progress.message = 'Le serveur a redémarré. Relance la sélection : les photos déjà importées seront ignorées.';
      }
      flows.set(id, flow);
    }
  }
  if (flow && (flow.connectionExpires <= Date.now() || (!flow.token && !flow.refreshToken && flow.expires <= Date.now()))) {
    flows.delete(id);
    removeGoogleConnection(id);
    return;
  }
  if (flow && flow.owner !== adminSessionKey(cookies)) {
    // A new admin login in the same browser may reuse its saved Google connection.
    flow.owner = adminSessionKey(cookies);
    saveFlow(flow);
  }
  return flow;
}

export function googlePhotosView(cookies: Cookies) {
  const flow = flowFor(cookies);
  return { configured: googlePhotosConfigured(), connected: !!(flow?.refreshToken || (flow?.token && flow.expires > Date.now())),
    pickerUri: flow?.session?.pickerUri || '', ready: !!flow?.session?.mediaItemsSet,
    importing: !!flow?.importing, progress: flow?.progress || null };
}

async function api<T>(token: string, path: string, method = 'GET', body?: object): Promise<T> {
  return readGoogleResponse(`${API}/${path}`, { method,
    headers: {Authorization: `Bearer ${token}`, ...(body ? {'Content-Type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined, redirect: 'error' }, 'Sélection Google Photos', async response => {
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('Accès Google Photos refusé ou expiré. Reconnecte ton compte.');
        if (response.status === 404) throw new Error('La sélection Google Photos a expiré. Commence une nouvelle sélection.');
        throw new Error(`Google Photos est indisponible (HTTP ${response.status}). Réessaie plus tard.`);
      }
      return response.status === 204 ? undefined as T : await response.json() as T;
    }, 30_000);
}

export async function clearGooglePhotos(cookies: Cookies) {
  const flow = flowFor(cookies);
  if (flow?.importing) throw new Error('Un import Google Photos est déjà en cours.');
  if (flow?.selecting) throw new Error('La création de la sélection Google Photos est déjà en cours.');
  if (flow?.token && flow.session) await api(flow.token, `sessions/${encodeURIComponent(flow.session.id)}`, 'DELETE').catch(() => {});
  const id = cookies.get(COOKIE) || '';
  flows.delete(id);
  removeGoogleConnection(id);
  cookies.delete(COOKIE, {path: '/admin'});
}

async function accessToken(flow: GoogleFlow): Promise<string> {
  if (flow.token && flow.expires > Date.now() + 60_000) return flow.token;
  if (flow.refreshing) return flow.refreshing;
  if (!flow.refreshToken) {
    if (flow.token && flow.expires > Date.now()) return flow.token;
    throw new Error('La connexion Google Photos a expiré. Reconnecte ton compte.');
  }
  flow.refreshing = (async () => {
    const response = await exchangeGoogleCode(new URLSearchParams({client_id: GOOGLE_PHOTOS_CLIENT_ID,
      client_secret: GOOGLE_PHOTOS_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: flow.refreshToken!}));
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        flow.token = undefined;
        flow.refreshToken = undefined;
        flow.session = undefined;
        saveFlow(flow);
        throw new Error('L’autorisation Google a expiré ou a été révoquée. Reconnecte ton compte une fois.');
      }
      throw new Error('Renouvellement Google Photos indisponible. Réessaie plus tard.');
    }
    const token = await response.json() as {access_token?: string; expires_in?: number; refresh_token?: string};
    if (!token.access_token) throw new Error('Renouvellement Google Photos invalide.');
    flow.token = token.access_token;
    flow.expires = Date.now() + (Number(token.expires_in) || 3600) * 1000;
    if (token.refresh_token) flow.refreshToken = token.refresh_token;
    saveFlow(flow);
    return flow.token;
  })();
  try { return await flow.refreshing; }
  finally { flow.refreshing = undefined; }
}

async function createSelection(flow: GoogleFlow) {
  if (flow.selecting) return flow.selecting;
  flow.selecting = (async () => {
    const token = await accessToken(flow);
    if (flow.session) await api(token, `sessions/${encodeURIComponent(flow.session.id)}`, 'DELETE').catch(() => {});
    flow.session = undefined;
    flow.progress = undefined;
    flow.nextPoll = 0;
    const session = await api<PickerSession>(token, 'sessions', 'POST', {});
    const picker = new URL(session.pickerUri);
    if (picker.protocol !== 'https:' || picker.hostname !== 'photos.google.com' || !session.id) throw new Error('Réponse Google Photos invalide.');
    flow.session = session;
    saveFlow(flow);
  })();
  try { await flow.selecting; }
  finally { flow.selecting = undefined; }
}

function rememberBrowser(cookies: Cookies, flow: GoogleFlow) {
  flow.connectionExpires = Date.now() + CONNECTION_AGE * 1000;
  cookies.set(COOKIE, flow.id, {path: '/admin', httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', maxAge: CONNECTION_AGE});
  saveFlow(flow);
}

export async function beginGooglePhotos(cookies: Cookies, {switchAccount = false} = {}) {
  if (!googlePhotosConfigured()) throw new Error('Configure les identifiants OAuth Google Photos sur le serveur.');
  const existing = flowFor(cookies);
  if (existing?.importing) throw new Error('Un import Google Photos est déjà en cours.');
  if (!switchAccount && existing && (existing.token || existing.refreshToken)) {
    await createSelection(existing);
    rememberBrowser(cookies, existing);
    return '/admin?view=imports&notice=Nouvelle+s%C3%A9lection+Google+Photos+pr%C3%AAte.';
  }
  await clearGooglePhotos(cookies);
  const id = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const flow: GoogleFlow = {id, owner: adminSessionKey(cookies), state, verifier, expires: Date.now() + 10 * 60_000,
    connectionExpires: Date.now() + CONNECTION_AGE * 1000, importing: false, nextPoll: 0};
  flows.set(id, flow);
  rememberBrowser(cookies, flow);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({client_id: GOOGLE_PHOTOS_CLIENT_ID, redirect_uri: GOOGLE_PHOTOS_REDIRECT_URI,
    response_type: 'code', scope: SCOPE, state, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), access_type: 'offline',
    prompt: switchAccount ? 'select_account consent' : 'consent'}).toString();
  return url.toString();
}

export async function finishGooglePhotos(cookies: Cookies, state: string, code: string) {
  const flow = flowFor(cookies);
  if (!flow || !state || flow.state !== state || !code) throw new Error('Connexion Google invalide ou expirée. Recommence la connexion.');
  // Consume the state before exchanging the code so the callback cannot be replayed.
  flow.state = '';
  saveFlow(flow);
  const response = await exchangeGoogleCode(new URLSearchParams({client_id: GOOGLE_PHOTOS_CLIENT_ID, client_secret: GOOGLE_PHOTOS_CLIENT_SECRET,
    redirect_uri: GOOGLE_PHOTOS_REDIRECT_URI, grant_type: 'authorization_code', code, code_verifier: flow.verifier}));
  if (!response.ok) throw new Error('La connexion Google a échoué. Vérifie la configuration OAuth et réessaie.');
  const token = await response.json() as {access_token?: string; refresh_token?: string; expires_in?: number; scope?: string};
  if (!token.access_token || !token.scope?.split(' ').includes(SCOPE)) throw new Error('Autorise la sélection de photos dans Google Photos pour continuer.');
  flow.token = token.access_token;
  flow.refreshToken = token.refresh_token;
  flow.verifier = '';
  flow.expires = Date.now() + Math.min(Number(token.expires_in) || 3600, 3600) * 1000;
  rememberBrowser(cookies, flow);
  await createSelection(flow);
}

export async function pollGooglePhotos(cookies: Cookies) {
  const flow = flowFor(cookies);
  if (flow?.progress && (!flow.session || flow.importing)) {
    if (flow.importing) saveFlow(flow);
    return {ready: !!flow.session?.mediaItemsSet, pollAfter: 1000, progress: flow.progress};
  }
  if (!flow?.token || !flow.session) throw new Error('La connexion Google Photos a expiré. Reconnecte ton compte.');
  if (!flow.importing && !flow.session.mediaItemsSet && Date.now() >= flow.nextPoll) {
    flow.nextPoll = Date.now() + 5000;
    flow.session = await api<PickerSession>(await accessToken(flow), `sessions/${encodeURIComponent(flow.session.id)}`);
    const seconds = Number.parseFloat(flow.session.pollingConfig?.pollInterval || '5s');
    flow.nextPoll = Date.now() + Math.max(5, Number.isFinite(seconds) ? seconds : 5) * 1000;
    saveFlow(flow);
  }
  return {ready: !!flow.session.mediaItemsSet, pollAfter: Math.max(5000, flow.nextPoll - Date.now()), progress: flow.progress || null};
}

export async function startGoogleSelection(cookies: Cookies,
  run: (photos: GooglePhoto[], token: () => Promise<string>, progress: GoogleImportProgress, ensureActive: () => void) => Promise<void>) {
  await pollGooglePhotos(cookies);
  const flow = flowFor(cookies);
  if (!flow?.token || !flow.session?.mediaItemsSet) throw new Error('Termine la sélection dans Google Photos avant de lancer l’import.');
  if (flow.importing) throw new Error('Un import Google Photos est déjà en cours.');
  flow.importing = true;
  const progress: GoogleImportProgress = {status: 'running', total: 0, processed: 0,
    imported: 0, duplicates: 0, created: 0, failed: 0, errors: [], selectedId: null, message: ''};
  flow.progress = progress;
  saveFlow(flow);
  // The POST returns immediately. Downloads run sequentially in the server so
  // large selections do not hold an HTTP request open or buffer all images.
  void (async () => {
    const photos: GooglePhoto[] = [];
    let pageToken = '';
    const seenTokens = new Set<string>();
    const sessionId = flow.session!.id;
    do {
      if (seenTokens.has(pageToken)) throw new Error('Google Photos a renvoyé une page répétée. Réessaie la sélection.');
      seenTokens.add(pageToken);
      const query = new URLSearchParams({sessionId, pageSize: '100', ...(pageToken ? {pageToken} : {})});
      const page = await api<{mediaItems?: GooglePhoto[]; nextPageToken?: string}>(await accessToken(flow), `mediaItems?${query}`);
      photos.push(...(page.mediaItems || []));
      progress.total = photos.length;
      pageToken = page.nextPageToken || '';
    } while (pageToken);
    if (!photos.length) throw new Error('Aucune photo sélectionnée.');
    await run(photos, () => accessToken(flow), progress, () => {
      if (flow.connectionExpires <= Date.now()) throw new Error('La connexion Google Photos a expiré. Reconnecte ton compte et sélectionne les photos restantes.');
    });
    if (!progress.failed) {
      await api(await accessToken(flow), `sessions/${encodeURIComponent(sessionId)}`, 'DELETE').catch(() => {});
      flow.session = undefined;
    }
    progress.status = 'done';
  })().catch(error => {
    progress.status = 'failed';
    progress.message = error instanceof Error ? error.message : 'Import Google Photos impossible.';
  }).finally(() => {
    flow.importing = false;
    try { saveFlow(flow); }
    catch { progress.status = 'failed'; progress.message = 'Impossible de mémoriser le suivi de l’import sur le serveur.'; }
  });
}

export function googlePhotoDate(createTime?: string): string | null {
  return googlePhotoTakenAt(createTime)?.slice(0, 10) ?? null;
}

export function googlePhotoTakenAt(createTime?: string): string | null {
  return localTakenAt(createTime);
}

export async function downloadGooglePhoto(photo: GooglePhoto, token: string): Promise<File> {
  if (!['PHOTO', 'VIDEO'].includes(photo.type)) throw new Error('Choisis une photo ou une vidéo.');
  const video = photo.type === 'VIDEO';
  if (video && photo.mediaFile.mediaFileMetadata?.videoMetadata?.processingStatus !== 'READY') {
    throw new Error('Cette vidéo n’est pas encore prête dans Google Photos. Réessaie après son traitement.');
  }
  const url = new URL(photo.mediaFile.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !(url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'))) {
    throw new Error('Adresse de téléchargement Google Photos invalide.');
  }
  return readGoogleResponse(`${url}=${video ? 'dv' : 'd'}`, {headers: {Authorization: `Bearer ${token}`},
    redirect: 'error'}, 'Téléchargement de la photo', async response => {
      if (!response.ok || !response.body) throw new Error('Téléchargement Google Photos impossible. Réessaie la sélection.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > (video ? MAX_VIDEO_FILE : MAX_FILE)) throw new Error(video ? 'Chaque vidéo doit faire au maximum 100 Mo.' : 'Chaque photo doit faire au maximum 12 Mo.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return new File([Buffer.concat(chunks)], photo.mediaFile.filename || (video ? 'Google Photos.mp4' : 'Google Photos.jpg'), {type: photo.mediaFile.mimeType});
    }, 120_000);
}
