import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { ADMIN_PASSWORD, SESSION_SECRET } from '$app/env/private';

const COOKIE = 'seretiny_admin';
const WEEK = 7 * 24 * 60 * 60;

export function authReady() {
  return (ADMIN_PASSWORD?.length ?? 0) >= 12 &&
    (SESSION_SECRET?.length ?? 0) >= 32 &&
    !SESSION_SECRET?.startsWith('REMPLACER_');
}

function same(a: string, b: string) {
  const aBuffer = Buffer.from(createHash('sha256').update(a).digest('hex'));
  const bBuffer = Buffer.from(createHash('sha256').update(b).digest('hex'));
  return timingSafeEqual(aBuffer, bBuffer);
}

export function passwordValid(input: string) {
  return authReady() && same(input, ADMIN_PASSWORD!);
}

function sign(expires: string) {
  return createHmac('sha256', SESSION_SECRET!).update(expires).digest('hex');
}

export function login(cookies: Cookies) {
  const expiry = String(Math.floor(Date.now()/1000) + WEEK);
  cookies.set(COOKIE, `${expiry}.${sign(expiry)}`, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: WEEK
  });
}

export function logout(cookies: Cookies) {
  cookies.delete(COOKIE, {path:'/'});
}

export function isAdmin(cookies: Cookies) {
  if (!authReady()) return false;
  const value = cookies.get(COOKIE);
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) return false;
  if (Number(parts[0]) <= Math.floor(Date.now()/1000)) return false;
  return same(parts[1], sign(parts[0]));
}

export function adminSessionKey(cookies: Cookies) {
  return createHash('sha256').update(cookies.get(COOKIE) || '').digest('hex');
}
