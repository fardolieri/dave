/**
 * Everything this app keeps in a browser, in one place (quality ticket 02). Runtime-neutral: plain data and parsers.
 *
 * Stored state outlives a deploy. A changed default reaches only browsers that never stored the setting, and a changed
 * shape meets values written in the old one. So every key is listed here with the parser all its reads go through and
 * fixtures of what browsers hold, and test/storedstate.test.ts snapshots each key's default, the shape its parser
 * returns, and what every fixture parses to. Changing any of them fails that test, which says what to do next.
 *
 * - A new key: add it here first. `local`, `idbGet` and `idbSet` (client/storage.ts) only take keys listed here.
 * - A new stored shape: add a fixture in it, and keep the old fixtures: they are what browsers out there still hold.
 *
 * Not listed: what posthog-js stores itself (`ph_*`, removed when telemetry is off, client/posthog.ts) and the service
 * worker's caches, which are named per build (client/sw.ts).
 */
import { parseRecentEmoji } from './emoji';
import { parseContacts } from './names';
import { normalisePicture } from './protocol';
import { parseRejoinMarker } from './rejoin';
import { parseStoredRooms } from './rooms';
import { parseHistory } from './chatlog';
import { parseAudioSettings, parseShareSettings, parseViewerSettings, parseVolumes } from './settings';

/** A stored key: what it holds, the parser every read goes through, and stored values from the wild. */
export type StoredKey<Raw> = {
  /** What it holds and where it is read and written. */
  about: string;
  /** The parser every read goes through. None when the value is not ours to parse (see `about`). */
  parse: ((raw: Raw) => unknown) | null;
  /**
   * Values as browsers hold them, one per stored format, oldest first and named after when or why the format began.
   * Copied from the format of the time and never edited: a browser that last wrote one still has it.
   */
  fixtures: Record<string, Raw>;
};

/** A plain string, read as it is. */
export const text = (raw: string | null): string | null => raw;
/** A yes/no flag, stored as 'true'; anything else is no. */
export const flag = (raw: string | null): boolean => raw === 'true';
/** The answer to "Want to help me find bugs?"; null while not asked. */
export const consent = (raw: string | null): 'on' | 'off' | null => (raw === 'on' || raw === 'off' ? raw : null);
export const picture = (raw: string | null): string | null => (raw ? normalisePicture(raw) : null);

/** localStorage, through `local` in client/storage.ts, which adds the `dave.` prefix. A missing value reads as null. */
export const LOCAL = {
  name: { about: 'My display name (client/invite.ts).', parse: text, fixtures: { 'Sep 6': 'Daniel' } },
  picture: { about: 'My profile picture, one emoji (client/invite.ts).', parse: picture, fixtures: { 'Sep 10': '🦕' } },
  seenKeys: {
    about: 'The address book: keys I acknowledged, their name, since when, my nickname for them (client/contacts.ts).',
    parse: parseContacts,
    fixtures: {
      'Sep 6, seen keys': '{"pkA":{"name":"Anna","since":1757160000000}}',
      'Sep 9, nicknames': '{"pkA":{"name":"Anna","since":1757160000000,"nick":"Annie"},"pkB":{"name":"Ben","since":1757419200000}}',
    },
  },
  rooms: {
    about: 'The rooms this browser entered: secret, name, when (client/rooms.ts).',
    parse: parseStoredRooms,
    fixtures: { 'Sep 16, rooms': '[{"secret":"s3cr3t","name":"Friends","addedAt":1757930000000},{"secret":"0th3r","name":"Gaming","addedAt":1757940000000}]' },
  },
  room: { about: 'The secret of the selected room (client/rooms.ts).', parse: text, fixtures: { 'Sep 16, rooms': 's3cr3t' } },
  secret: { about: 'The one room secret from before rooms; folded into `rooms` on load and removed (client/rooms.ts).', parse: text, fixtures: { 'Sep 6': 's3cr3t' } },
  emojiRecent: { about: 'Emoji picked last, newest first (client/EmojiPicker.tsx).', parse: parseRecentEmoji, fixtures: { 'Sep 10': '["🎉","😀"]' } },
  test: { about: 'Set by the e2e fixtures: this browser is a test account (client/posthog.ts).', parse: flag, fixtures: { 'e2e seed': 'true' } },
  telemetry: { about: 'The telemetry answer (client/posthog.ts).', parse: consent, fixtures: { 'Sep 27, yes': 'on', 'Sep 27, no': 'off' } },
  muted: { about: 'My microphone was muted when last in a call (client/call.ts).', parse: flag, fixtures: { 'Sep 6, muted': 'true', 'Sep 6, unmuted': 'false' } },
  rejoin: {
    about: 'Rejoin marker, kept fresh while in a call (core/rejoin.ts, client/call.ts).',
    parse: parseRejoinMarker,
    fixtures: { 'Sep 24, rejoin': '{"room":"roomId","at":1758700000000,"watching":["pkB"]}' },
  },
  shareSettings: {
    about: 'My share settings (core/settings.ts, client/call.ts).',
    parse: parseShareSettings,
    fixtures: {
      'Sep 6, profiles': '{"preset":"detail","frameRate":30,"maxHeight":0,"degradation":"maintain-resolution","budgetBps":8000000,"ceilingBps":2500000}',
      'Sep 23, no profiles': '{"frameRate":30,"maxHeight":0,"degradation":"maintain-resolution","budgetBps":20000000,"ceilingBps":6000000}',
    },
  },
  volumes: { about: 'Local voice volume per friend key (client/call.ts).', parse: parseVolumes, fixtures: { 'Sep 7': '{"pkA":0.5,"pkB":2}' } },
  shareVolumes: { about: "Local volume of a friend's share sound, per key (client/call.ts).", parse: parseVolumes, fixtures: { 'Oct 5': '{"pkA":0,"pkB":1.5}' } },
  audioSettings: {
    about: 'My audio settings (core/settings.ts, client/call.ts).',
    parse: parseAudioSettings,
    fixtures: {
      'Sep 6, devices': '{"echoCancellation":true,"noiseSuppression":false,"autoGainControl":true,"microphoneId":"mic1","speakerId":""}',
      'Sep 22, master volume': '{"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true,"microphoneId":"","speakerId":"spk1","masterVolume":1.5}',
      'Sep 28, voice repair': '{"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true,"microphoneId":"","speakerId":"","masterVolume":1,"noiseRemoval":false,"voiceThreshold":0.3,"lowBandwidthVoice":true,"voiceRepair":"red"}',
    },
  },
  viewerSettings: { about: 'Low latency for shares I watch (core/settings.ts, client/call.ts).', parse: parseViewerSettings, fixtures: { 'Sep 6, low latency': '{"jitterBufferTargetMs":100}' } },
} satisfies Record<string, StoredKey<string | null>>;
export type LocalKey = keyof typeof LOCAL;

/** IndexedDB, database `dave`, store `kv`, through `idbGet` and `idbSet` in client/storage.ts. A missing value reads as undefined. */
export const IDB = {
  identity: {
    about: 'My identity keypair, a non-extractable CryptoKeyPair (client/identity.ts). Not parsed: a missing one means a new identity, by design.',
    parse: null,
    fixtures: {},
  },
  'history:<roomId>': {
    about: 'Chat history of one room, texts only (core/chatlog.ts, client/history.ts).',
    parse: parseHistory,
    fixtures: {
      'Sep 16, with reconnect notes': [{ from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna' }, text: 'hi', at: 1757500000000 }, { note: 'Reconnected after 12 s', at: 1757500001000 }],
      'Sep 20, texts only': [{ from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' }, text: 'hi', at: 1758300000000 }],
    },
  },
  history: {
    about: 'The one chat history from before rooms; moved to `history:<roomId>` on load and removed (client/history.ts).',
    parse: parseHistory,
    fixtures: { 'Sep 8, before rooms': [{ from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna' }, text: 'hi', at: 1757500000000 }] },
  },
} satisfies Record<string, StoredKey<unknown>>;
export type IdbKey = Exclude<keyof typeof IDB, 'history:<roomId>'> | `history:${string}`;

/** sessionStorage, per tab and gone with it, so a changed shape meets old values only across one reload. Read in place. */
export const SESSION = {
  'dave.tabHeld': { about: 'This tab held the tab lock, so its reload takes it back (client/tablock.ts).', parse: null, fixtures: {} },
  'dave.update-taken': { about: 'When this tab last took an update on open, to stop a reload loop (client/update.ts).', parse: null, fixtures: {} },
} satisfies Record<string, StoredKey<string | null>>;

/** Field names and types of a value: `{ a: 'number', b: ['string'] }`. Arrays list the distinct shapes of their items. */
export function shapeOf(v: unknown): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const seen = new Map<string, unknown>();
    for (const item of v) { const s = shapeOf(item); seen.set(JSON.stringify(s), s); }
    return [...seen.values()];
  }
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]));
  return typeof v;
}

/** Every key with its snapshot id and what a read gives with nothing stored: null for Web Storage, undefined for IndexedDB. */
export type ListedKey = { id: string; entry: StoredKey<unknown>; absent: null | undefined };
export function allStoredKeys(): ListedKey[] {
  const list = (prefix: string, keys: Record<string, unknown>, absent: null | undefined) =>
    Object.entries(keys).map(([k, entry]) => ({ id: `${prefix}${k}`, entry: entry as StoredKey<unknown>, absent }));
  return [...list('localStorage dave.', LOCAL, null), ...list('IndexedDB ', IDB, undefined), ...list('sessionStorage ', SESSION, null)];
}

/**
 * What test/storedstate.test.ts compares, per key: what a read gives with nothing stored (the default), the shape of
 * what the newest fixture parses to, and what each fixture parses to. Keys without a parser say so.
 */
export function storedStateSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { id, entry: { parse, fixtures }, absent } of allStoredKeys()) {
    if (!parse) { out[id] = 'not parsed'; continue; }
    const stored = Object.entries(fixtures);
    const newest = stored[stored.length - 1];
    out[id] = {
      default: parse(absent) ?? null,
      shape: newest ? shapeOf(parse(newest[1])) : 'no fixture',
      fixtures: Object.fromEntries(stored.map(([name, raw]) => [name, parse(raw) ?? null])),
    };
  }
  return out;
}
