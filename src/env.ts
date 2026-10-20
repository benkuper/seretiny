import { defineEnvVars } from '@sveltejs/kit/env';

// Private runtime variables, loaded from .env in development and from the
// server environment in production. Keep missing secrets optional so the
// login page can show its configuration message.
export const variables = defineEnvVars({
  ADMIN_PASSWORD: {},
  SESSION_SECRET: {},
  DATA_DIR: {},
  FFMPEG_PATH: { schema: value => value || 'ffmpeg' },
  FFPROBE_PATH: { schema: value => value || 'ffprobe' },
  GOOGLE_PHOTOS_CLIENT_ID: { schema: value => value || '' },
  GOOGLE_PHOTOS_CLIENT_SECRET: { schema: value => value || '' },
  GOOGLE_PHOTOS_REDIRECT_URI: { schema: value => value || '' },
  GOOGLE_PHOTOS_TIME_ZONE: { schema: value => value || 'Europe/Paris' }
});
