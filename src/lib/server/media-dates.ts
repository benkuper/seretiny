import { GOOGLE_PHOTOS_TIME_ZONE } from '$app/env/private';
import { dateValid } from './db.js';

// Camera EXIF is already local. UTC video/Google timestamps need the journal's time zone.
export function localTakenAt(value?: string): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  const parts = new Intl.DateTimeFormat('en', {timeZone: GOOGLE_PHOTOS_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23'}).formatToParts(new Date(value));
  const part = (name: string) => parts.find(item => item.type === name)?.value;
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  return dateValid(date) ? `${date}T${part('hour')}:${part('minute')}:${part('second')}.${part('fractionalSecond')}` : null;
}
