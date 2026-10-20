import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAdmin } from '#lib/server/auth.js';
import { finishGooglePhotos } from '#lib/server/google-photos.js';

export const GET: RequestHandler = async ({cookies, url}) => {
  if (!isAdmin(cookies)) redirect(303, '/admin/login');
  let message = '';
  try {
    if (url.searchParams.has('error')) throw new Error('Connexion Google annulée ou refusée.');
    await finishGooglePhotos(cookies, url.searchParams.get('state') || '', url.searchParams.get('code') || '');
  } catch (error) {
    message = error instanceof Error ? error.message : 'Connexion Google Photos impossible.';
  }
  redirect(303, `/admin?view=imports&${new URLSearchParams(message ? {warning: message} : {notice: 'Google Photos est connecté. Ouvre la sélection, puis reviens importer les photos.'})}`);
};
