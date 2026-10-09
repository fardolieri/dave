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
   * Values as browsers hold them, one per stored format, each named `YYYY-MM-DD, why`: the day the format began. The
   * newest date is today's format. Copied from the format of the time and never edited: a browser that last wrote one
   * still has it.
   */
  fixtures: Record<string, Raw>;
  /** The stored value is a map whose keys are data (friend keys), so its shape is that of its values. */
  map?: true;
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
  name: { about: 'My display name (client/invite.ts).', parse: text, fixtures: { '2026-09-06': 'Daniel' } },
  picture: { about: 'My profile picture, one emoji (client/invite.ts).', parse: picture, fixtures: { '2026-09-10': '🦕' } },
  seenKeys: {
    about: 'The address book: keys I acknowledged, their name, since when, my nickname for them (client/contacts.ts).',
    parse: parseContacts,
    map: true,
    fixtures: {
      '2026-09-06, seen keys': '{"pkA":{"name":"Anna","since":1757160000000}}',
      '2026-09-09, nicknames': '{"pkA":{"name":"Anna","since":1757160000000,"nick":"Annie"},"pkB":{"name":"Ben","since":1757419200000}}',
    },
  },
  rooms: {
    about: 'The rooms this browser entered: secret, name, when (client/rooms.ts).',
    parse: parseStoredRooms,
    fixtures: { '2026-09-16, rooms': '[{"secret":"s3cr3t","name":"Friends","addedAt":1757930000000},{"secret":"0th3r","name":"Gaming","addedAt":1757940000000}]' },
  },
  room: { about: 'The secret of the selected room (client/rooms.ts).', parse: text, fixtures: { '2026-09-16, rooms': 's3cr3t' } },
  secret: { about: 'The one room secret from before rooms; folded into `rooms` on load and removed (client/rooms.ts).', parse: text, fixtures: { '2026-09-06': 's3cr3t' } },
  emojiRecent: { about: 'Emoji picked last, newest first (client/EmojiPicker.tsx).', parse: parseRecentEmoji, fixtures: { '2026-09-10': '["🎉","😀"]' } },
  test: { about: 'Set by the e2e fixtures: this browser is a test account (client/posthog.ts).', parse: flag, fixtures: { '2026-09-10, e2e seed': 'true' } },
  telemetry: { about: 'The telemetry answer (client/posthog.ts).', parse: consent, fixtures: { '2026-09-27, yes': 'on', '2026-09-27, no': 'off' } },
  muted: { about: 'My microphone was muted when last in a call (client/call.ts).', parse: flag, fixtures: { '2026-09-06, muted': 'true', '2026-09-06, unmuted': 'false' } },
  rejoin: {
    about: 'Rejoin marker, kept fresh while in a call (core/rejoin.ts, client/call.ts).',
    parse: parseRejoinMarker,
    fixtures: { '2026-09-24, rejoin': '{"room":"roomId","at":1758700000000,"watching":["pkB"]}' },
  },
  shareSettings: {
    about: 'My share settings (core/settings.ts, client/call.ts).',
    parse: parseShareSettings,
    fixtures: {
      '2026-09-06, profiles': '{"preset":"detail","frameRate":30,"maxHeight":0,"degradation":"maintain-resolution","budgetBps":8000000,"ceilingBps":2500000}',
      '2026-09-23, no profiles': '{"frameRate":30,"maxHeight":0,"degradation":"maintain-resolution","budgetBps":20000000,"ceilingBps":6000000}',
    },
  },
  volumes: { about: 'Local voice volume per friend key (client/call.ts).', parse: parseVolumes, map: true, fixtures: { '2026-09-07': '{"pkA":0.5,"pkB":2}' } },
  shareVolumes: { about: "Local volume of a friend's share sound, per key (client/call.ts).", parse: parseVolumes, map: true, fixtures: { '2026-10-05': '{"pkA":0,"pkB":1.5}' } },
  audioSettings: {
    about: 'My audio settings (core/settings.ts, client/call.ts).',
    parse: parseAudioSettings,
    fixtures: {
      '2026-09-06, devices': '{"echoCancellation":true,"noiseSuppression":false,"autoGainControl":true,"microphoneId":"mic1","speakerId":""}',
      '2026-09-22, master volume': '{"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true,"microphoneId":"","speakerId":"spk1","masterVolume":1.5}',
      '2026-09-28, voice repair': '{"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true,"microphoneId":"","speakerId":"","masterVolume":1,"noiseRemoval":false,"voiceThreshold":0.3,"lowBandwidthVoice":true,"voiceRepair":"red"}',
    },
  },
  viewerSettings: { about: 'Low latency for shares I watch (core/settings.ts, client/call.ts).', parse: parseViewerSettings, fixtures: { '2026-09-06, low latency': '{"jitterBufferTargetMs":100}' } },
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
      '2026-09-16, with reconnect notes': [{ from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna' }, text: 'hi', at: 1757500000000 }, { note: 'Reconnected after 12 s', at: 1757500001000 }],
      '2026-09-20, texts only': [{ from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' }, text: 'hi', at: 1758300000000 }],
    },
  },
  history: {
    about: 'The one chat history from before rooms; moved to `history:<roomId>` on load and removed (client/history.ts).',
    parse: parseHistory,
    fixtures: { '2026-09-08, before rooms': [{ from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna' }, text: 'hi', at: 1757500000000 }] },
  },
} satisfies Record<string, StoredKey<unknown>>;
export type IdbKey = Exclude<keyof typeof IDB, 'history:<roomId>'> | `history:${string}`;

/** sessionStorage, per tab and gone with it, so a changed shape meets old values only across one reload. Read in place. */
export const SESSION = {
  'dave.tabHeld': { about: 'This tab held the tab lock, so its reload takes it back (client/tablock.ts).', parse: null, fixtures: {} },
  'dave.update-taken': { about: 'When this tab last took an update on open, to stop a reload loop (client/update.ts).', parse: null, fixtures: {} },
  'dave.update-taken-ms': { about: 'The ms from the load to its last take of an update on open, told to PostHog by the next page (client/update.ts).', parse: null, fixtures: {} },
} satisfies Record<string, StoredKey<string | null>>;

/**
 * Field names and types of a value: `{ a: 'number', b: ['string'] }`. The items of a list (and the values of a `map`)
 * merge into one shape: a field only some of them have is marked optional (`nick?`), differing types join (`a|b`).
 */
export function shapeOf(v: unknown, map = false): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [mergeShapes(v.map((x) => shapeOf(x)))] : [];
  if (typeof v !== 'object') return typeof v;
  const values = Object.values(v as Record<string, unknown>);
  if (map) return values.length ? { '<key>': mergeShapes(values.map((x) => shapeOf(x))) } : {};
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]));
}

const isRecordShape = (s: unknown): s is Record<string, unknown> => typeof s === 'object' && s !== null && !Array.isArray(s);
function mergeShapes(shapes: unknown[]): unknown {
  if (shapes.length > 1 && shapes.every(isRecordShape)) {
    const fields = [...new Set(shapes.flatMap((s) => Object.keys(s).map((k) => k.replace(/\?$/, ''))))].sort();
    return Object.fromEntries(fields.map((f) => {
      const has = shapes.filter((s) => f in s || `${f}?` in s);
      const optional = has.length < shapes.length || has.some((s) => `${f}?` in s);
      return [optional ? `${f}?` : f, mergeShapes(has.map((s) => s[f] ?? s[`${f}?`]))];
    }));
  }
  const distinct = [...new Map(shapes.map((s) => [JSON.stringify(s), s])).values()];
  return distinct.length === 1 ? distinct[0] : distinct.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).sort().join('|');
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
  for (const { id, entry, absent } of allStoredKeys()) {
    const { parse, fixtures } = entry;
    if (!parse) { out[id] = 'not parsed'; continue; }
    const stored = Object.entries(fixtures);
    const newest = stored.reduce<[string, unknown] | undefined>((n, f) => (!n || f[0] > n[0] ? f : n), undefined); // names start with the date
    out[id] = {
      default: parse(absent) ?? null,
      shape: newest ? shapeOf(parse(newest[1]), !!entry.map) : 'no fixture',
      fixtures: Object.fromEntries(stored.map(([name, raw]) => [name, parse(raw) ?? null])),
    };
  }
  return out;
}
