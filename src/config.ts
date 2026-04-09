import { z } from 'zod/v4';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  CLIENT_ID: z.string().min(1, 'CLIENT_ID is required'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  YT_COOKIES_FILE: z.string().optional(),
  YT_COOKIES_FROM_BROWSER: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues.map(
    (e: z.core.$ZodIssue) => `  - ${e.path.join('.')}: ${e.message}`,
  );
  process.stderr.write(`Missing or invalid environment variables:\n${errors.join('\n')}\n`);
  process.stderr.write('See .env.example for required variables.\n');
  process.exit(1);
}

export const config = {
  ...parsed.data,
  BOT_PREFIX: '/',
  MAX_QUEUE_SIZE: 200,
  MAX_PLAYLIST_SIZE: 15,
} as const;
