import type { RequestHandler } from './$types';
import { createHash } from 'node:crypto';
import { createComment } from '#lib/server/db.js';
import { SESSION_SECRET } from '$app/env/private';

export const POST: RequestHandler = async ({request,getClientAddress}) => {
  try {
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return Response.json({error:'Format de requête invalide.'},{status:415});
    const body = await request.text();
    if (body.length > 4000) return Response.json({error:'Message trop long.'},{status:413});
    const data = JSON.parse(body);
    if (typeof data.website === 'string' && data.website.trim()) return Response.json({ok:true}); // champ piège anti-spam
    const dayId = Number(data.dayId);
    const author = typeof data.author === 'string' ? data.author.trim() : '';
    const message = typeof data.message === 'string' ? data.message.trim() : '';
    if (!Number.isSafeInteger(dayId) || dayId < 1 || author.length < 2 || author.length > 60 || message.length < 3 || message.length > 1000)
      return Response.json({error:'Nom (2–60 caractères) et commentaire (3–1 000 caractères) requis.'},{status:400});
    const salt = SESSION_SECRET || 'seretiny-rate-limit';
    const ipHash = createHash('sha256').update(salt+getClientAddress()).digest('hex');
    createComment(dayId,author,message,ipHash);
    return Response.json({ok:true});
  } catch (error) {
    return Response.json({error: error instanceof Error ? error.message : 'Une erreur est survenue.'},{status:400});
  }
};
