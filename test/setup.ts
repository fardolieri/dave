// Runs in every test file (vitest.config.ts, setupFiles).
import { afterAll } from 'vitest';

// Imported when the file ends, not before it starts: the harness loads the Worker, which a file's vi.mock must come
// before (turn.test.ts). By then a file that connects has loaded it, and gets the rooms it opened.
afterAll(async () => (await import('./harness')).keepsSettled());
