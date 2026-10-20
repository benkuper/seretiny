import type { PageServerLoad } from './$types';
import { chapters, days } from '#lib/server/db.js';
import { indexExistingTakenDates } from '#lib/server/images.js';

export const load: PageServerLoad = async () => {
  await indexExistingTakenDates();
  return { days: days(true), chapters: chapters().filter(chapter => chapter.start_date) };
};
