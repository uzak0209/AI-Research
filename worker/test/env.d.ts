import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env } from '../src/index';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
    JWT_SIGNING_KEY: string;
    ORCAROUTER_API_KEY: string;
    OPENALEX_API_KEY: string;
  }
}
