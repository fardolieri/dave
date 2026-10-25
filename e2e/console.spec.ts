import { expect, test } from '@playwright/test';
import { unexplained } from './console';

// The judge of a friend's console (e2e/console.ts), without a browser: what the app got over passes, nothing else does.
const failed = (room: string) => `error: WebSocket connection to 'wss://dave-pr-89.example.workers.dev/ws/${room}Xq0cmjteA6Xz5GhzLJ' failed: Error during WebSocket handshake: net::ERR_CONNECTION_RESET`;

test('a socket the browser could not open is excused once the app says that room recovered after it', () => {
  expect(unexplained([failed('aaa'), failed('aaa')], [], [{ room: 'aaa', after: 2 }])).toEqual([]);
});

test('a socket error with no recovery after it, or only another room\'s, still fails', () => {
  expect(unexplained([failed('aaa')], [], [])).toEqual([failed('aaa')]);
  expect(unexplained([failed('aaa')], [], [{ room: 'bbb', after: 1 }])).toEqual([failed('aaa')]);
  // The room recovered before this failure, and never after it.
  expect(unexplained(['warning: something', failed('aaa')], [/something/], [{ room: 'aaa', after: 1 }])).toEqual([failed('aaa')]);
});

test('a recovery excuses no other problem', () => {
  const other = 'error: sealing a text failed';
  expect(unexplained([other, failed('aaa')], [], [{ room: 'aaa', after: 2 }])).toEqual([other]);
});
