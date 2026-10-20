export type Language = 'fr' | 'en';

export type GoogleImportProgress = {
  status: 'running' | 'done' | 'failed';
  total: number;
  processed: number;
  imported: number;
  duplicates: number;
  created: number;
  failed: number;
  errors: string[];
  selectedId: number | null;
  message: string;
};

export type Chapter = {
  id: number;
  title_fr: string;
  title_en: string;
  sort_order: number;
  start_date: string | null;
  end_date: string | null;
};

export type Photo = {
  id: string;
  day_id: number;
  // Local camera time, or Google time converted to the configured photo time zone.
  taken_at: string | null;
  kind: 'photo' | 'video';
  caption_fr: string;
  caption_en: string;
  sort_order: number;
  original_name: string;
};

export type Comment = {
  id: number;
  day_id: number;
  author: string;
  body: string;
  created_at: string;
  approved: number;
};

export type Day = {
  id: number;
  date: string;
  title_fr: string;
  title_en: string;
  body_fr: string;
  body_en: string;
  chapter_id: number | null;
  chapter_fr: string | null;
  chapter_en: string | null;
  published: number;
  photos: Photo[];
  comments: Comment[];
};
