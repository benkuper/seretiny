import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAdmin } from '#lib/server/auth.js';
import { pollGooglePhotos } from '#lib/server/google-photos.js';

export const GET: RequestHandler = async ({cookies}) => {
  const headers = {'Cache-Control': 'no-store'};
  if (!isAdmin(cookies)) return json({message: 'Authentification requise.'}, {status: 401, headers});
  try { return json(await pollGooglePhotos(cookies), {headers}); }
  catch (error) { return json({message: error instanceof Error ? error.message : 'Google Photos indisponible.'}, {status: 400, headers}); }
};
