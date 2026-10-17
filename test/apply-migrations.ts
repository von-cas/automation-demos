import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import type { Env } from '../src/env';

const e = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
