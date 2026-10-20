import type { PageServerLoad, Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { authReady, isAdmin, login } from '#lib/server/auth.js';

export const load: PageServerLoad = ({cookies}) => {
  if (isAdmin(cookies)) redirect(303,'/admin');
  return { ready: authReady() };
};

export const actions: Actions = {
  default: async ({request,cookies}) => {
    const fd = await request.formData();
    if (!authReady()) return fail(503,{message:'Configure ADMIN_PASSWORD et SESSION_SECRET dans .env avant de te connecter.'});
    const {passwordValid} = await import('#lib/server/auth.js');
    if (!passwordValid(String(fd.get('password') || ''))) return fail(401,{message:'Mot de passe incorrect.'});
    login(cookies);
    redirect(303,'/admin');
  }
};
