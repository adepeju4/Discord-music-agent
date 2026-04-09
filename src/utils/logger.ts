import pino from 'pino';
import { randomUUID } from 'node:crypto';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: isProduction ? 'info' : 'debug',
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
  redact: {
    paths: [
      'token',
      'apiKey',
      'secret',
      'password',
      'authorization',
      'DISCORD_TOKEN',
      'GEMINI_API_KEY',
    ],
    censor: '[REDACTED]',
  },
});

export function createCorrelationId(): string {
  return randomUUID().slice(0, 8);
}

export function childLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
