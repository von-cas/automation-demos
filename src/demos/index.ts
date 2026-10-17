// Demo routes register here. Demo 1 (speed-to-lead), 2 (booking) and 3 (invoice) add their own
// files in this folder, import the shared core, and append to `demoRoutes`.
import type { Env } from '../env';

export interface DemoRoute {
  method: 'GET' | 'POST';
  path: string;
  handle: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
}

export const demoRoutes: DemoRoute[] = [];
