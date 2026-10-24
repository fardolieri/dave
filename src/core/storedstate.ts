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
import { parseHistory, parsePrivateThreads } from './chatlog';
import { parseBigIndex, parseFileIndex, parsePartialPull } from './attachment';
import { parseUnsent, parseUnsentPrivate } from './unsent';
import { parseCounts, parseRoomThemes } from './unread';
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
  unreadRooms: {
    about: "Texts that came while a room was not on screen, by room id, kept over a reload (core/unread.ts, client/room.ts).",
    parse: parseCounts,
    map: true,
    fixtures: { '2026-10-24, unread kept': '{"roomA":3}' },
  },
  unreadPrivate: {
    about: "Private texts that came while their conversation was not on screen, by friend key, kept over a reload (core/unread.ts, client/privates.ts).",
    parse: parseCounts,
    map: true,
    fixtures: { '2026-10-24, unread kept': '{"pkA":2}' },
  },
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
  unsent: {
    about: 'My own texts the Room has not brought back yet, per room id, sent again after a reload (core/unsent.ts, client/history.ts).',
    parse: parseUnsent,
    map: true,
    fixtures: { '2026-10-14, unsent texts': '{"roomA":[{"id":"0a1b2c3d4e5f60718293a4b5","text":"hi","at":1760450000000}]}' },
  },
  unsentPrivate: {
    about: 'My own private texts (ADR 0007) the Room has not brought back yet, per room id, with their friend, sent again after a reload once the Room lists them (core/unsent.ts, client/history.ts).',
    parse: parseUnsentPrivate,
    map: true,
    fixtures: { '2026-10-20, private texts': '{"roomA":[{"id":"0a1b2c3d4e5f60718293a4b5","to":{"publicKey":"pkB","fingerprint":"DEF456","name":"Ben","picture":"🦕"},"text":"hi","at":1760900000000},{"id":"1a1b2c3d4e5f60718293a4b5","to":{"publicKey":"pkC","fingerprint":"GHI789","name":"Cleo"},"text":"yo","at":1760900001000,"out":true}]}' },
  },
  theme: { about: 'The look picked before rooms had their own, a file name in client/themes/; none is the default look. Read once on the update: it becomes the pick of each room there is, in `roomThemes`, and is removed (client/theme.ts).', parse: text, fixtures: { '2026-10-15': 'fd-walkie' } },
  roomThemes: {
    about: "Each room's own look, by room id, picked from its ⋯ menu: a file name in client/themes/, '' for the default look (client/theme.ts).",
    parse: parseRoomThemes,
    map: true,
    fixtures: { '2026-10-24, a look per room': '{"roomA":"fd-walkie","roomB":""}' },
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
  privateTextKey: {
    about: 'My private text key (ADR 0007), a non-extractable ECDH CryptoKeyPair (client/identity.ts). Not parsed: a missing one means a new key, which friends learn from presence.',
    parse: null,
    fixtures: {},
  },
  'history:<roomId>': {
    about: 'Chat history of one room, texts only (core/chatlog.ts, client/history.ts).',
    parse: parseHistory,
    fixtures: {
      '2026-09-16, with reconnect notes': [{ from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna' }, text: 'hi', at: 1757500000000 }, { note: 'Reconnected after 12 s', at: 1757500001000 }],
      '2026-09-20, texts only': [{ from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' }, text: 'hi', at: 1758300000000 }],
      '2026-10-14, text ids': [
        { from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' }, text: 'hi', at: 1760450000000, id: '0a1b2c3d4e5f60718293a4b5' },
        { from: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' }, text: 'from an old client', at: 1760450001000 },
      ],
      '2026-10-15, attachments': [
        { from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' }, text: 'hi', at: 1760500000000, id: '0a1b2c3d4e5f60718293a4b5' },
        {
          from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna' }, text: 'cat.jpg', at: 1760500001000, id: '1a1b2c3d4e5f60718293a4b5',
          file: { name: 'cat.jpg', type: 'image/jpeg', size: 123456, hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg', preview: 'data:image/webp;base64,UklGRg==', width: 4032, height: 3024 },
        },
        {
          from: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' }, text: 'notes.zip', at: 1760500002000, id: '2a1b2c3d4e5f60718293a4b5',
          file: { name: 'notes.zip', type: 'application/zip', size: 2048, hash: 'AAAAgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg' },
        },
        { from: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' }, text: 'from an old client', at: 1760500003000 },
      ],
      '2026-10-19, private texts': [
        { from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' }, text: 'hi', at: 1760900000000, id: '0a1b2c3d4e5f60718293a4b5' },
        { from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna' }, text: 'just between us', at: 1760900001000, id: '1a1b2c3d4e5f60718293a4b5', to: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' } },
        { from: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' }, text: 'ok', at: 1760900001200, id: '5a1b2c3d4e5f60718293a4b5', to: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' } },
        {
          from: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' }, text: 'cat.jpg', at: 1760900001500, id: '3a1b2c3d4e5f60718293a4b5',
          file: { name: 'cat.jpg', type: 'image/jpeg', size: 123456, hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg', preview: 'data:image/webp;base64,UklGRg==', width: 4032, height: 3024 },
        },
        { from: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' }, text: 'a stray to', at: 1760900002000, id: '2a1b2c3d4e5f60718293a4b5', to: { name: 'no key' } },
        {
          from: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' }, text: 'notes.zip', at: 1760900003000, id: '4a1b2c3d4e5f60718293a4b5',
          file: { name: 'notes.zip', type: 'application/zip', size: 2048, hash: 'AAAAgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg' },
        },
        { from: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' }, text: 'from an old client', at: 1760900004000 },
      ],
    },
  },
  'private:<friendKey>': {
    about: 'My private conversation with one friend (ADR 0007), texts and files both ways, whichever room carried them; like a room\'s history (core/chatlog.ts, client/history.ts).',
    parse: parseHistory,
    fixtures: {
      '2026-10-21, private conversations': [
        { from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' }, text: 'just between us', at: 1761000000000, id: '0a1b2c3d4e5f60718293a4b5' },
        { from: { publicKey: 'pkMe', fingerprint: 'XYZ789', name: 'Me' }, text: 'ok', at: 1761000001000, id: '1a1b2c3d4e5f60718293a4b5' },
      ],
      '2026-10-21, private files': [
        { from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' }, text: 'just between us', at: 1761000000000, id: '0a1b2c3d4e5f60718293a4b5' },
        {
          from: { publicKey: 'pkMe', fingerprint: 'XYZ789', name: 'Me' }, text: 'cat.jpg', at: 1761000001000, id: '1a1b2c3d4e5f60718293a4b5',
          file: { name: 'cat.jpg', type: 'image/jpeg', size: 123456, hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg', preview: 'data:image/webp;base64,UklGRg==', width: 4032, height: 3024 },
        },
        { from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna' }, text: 'notes.zip', at: 1761000002000, id: '2a1b2c3d4e5f60718293a4b5', file: { name: 'notes.zip', type: 'application/zip', size: 2048, hash: 'AAAAgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg' } },
      ],
    },
  },
  privateThreads: {
    about: 'My private conversations, most recent first: the friend and when the last text came or went (core/chatlog.ts, client/history.ts).',
    parse: parsePrivateThreads,
    fixtures: {
      '2026-10-21, private conversations': [
        { friend: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna', picture: '🦕' }, at: 1761000001000 },
        { friend: { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' }, at: 1760900000000 },
        { friend: { name: 'no key' }, at: 1 },
      ],
    },
  },
  files: {
    about: 'The files this browser keeps, oldest first, with their size, within a budget (core/attachment.ts, client/files.ts).',
    parse: parseFileIndex,
    fixtures: { '2026-10-15, attachments': [{ hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg', size: 123456, at: 1760500001000 }] },
  },
  bigFiles: {
    about: 'Large files complete in the Origin Private File System (directory `files`, one file `<hash>`, or segments `<hash>.<n>` of 16 MB from before 2026-10-17), outside the budget, gone after BIG_KEEP_MS (attachments ticket 03, client/files.ts).',
    parse: parseBigIndex,
    fixtures: { '2026-10-16, large files': [{ hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg', size: 734003200, at: 1760600000000 }] },
  },
  'partial:<hash>': {
    about: 'How far a pull of a large file got: bytes on disk and checked, from the start (client/files.ts). A pull goes on from there.',
    parse: parsePartialPull,
    fixtures: { '2026-10-16, large files': { verified: 16777216, size: 734003200, at: 1760600000000 } },
  },
  'pieces:<hash>': {
    about: "A large file's list of piece hashes, a Uint8Array of 32 bytes each, checked against the file's hash as pulled (client/files.ts). Not parsed: it is checked where it is read.",
    parse: null,
    fixtures: {},
  },
  'file:<hash>': {
    about: "One file's bytes, a Blob, by the SHA-256 its announcement names (client/files.ts). Not parsed: the hash is checked as it is pulled.",
    parse: null,
    fixtures: {},
  },
  history: {
    about: 'The one chat history from before rooms; moved to `history:<roomId>` on load and removed (client/history.ts).',
    parse: parseHistory,
    fixtures: { '2026-09-08, before rooms': [{ from: { publicKey: 'pkA', fingerprint: 'ABC123', name: 'Anna' }, text: 'hi', at: 1757500000000 }] },
  },
} satisfies Record<string, StoredKey<unknown>>;
export type IdbKey = Exclude<keyof typeof IDB, 'history:<roomId>' | 'private:<friendKey>' | 'file:<hash>' | 'partial:<hash>' | 'pieces:<hash>'> | `history:${string}` | `private:${string}` | `file:${string}` | `partial:${string}` | `pieces:${string}`;

/** sessionStorage, per tab and gone with it, so a changed shape meets old values only across one reload. Read in place. */
export const SESSION = {
  'dave.tabHeld': { about: 'This tab held the tab lock, so its reload takes it back (client/tablock.ts).', parse: null, fixtures: {} },
  'dave.update-taken': { about: 'When this tab last took an update on open, to stop a reload loop (client/update.ts).', parse: null, fixtures: {} },
  'dave.update-taken-ms': { about: 'The ms from the load to its last take of an update on open, told to PostHog by the next page (client/update.ts).', parse: null, fixtures: {} },
  'dave.load-retried': { about: 'When this tab last reloaded for an app script that failed to load, to stop a reload loop (index.html).', parse: null, fixtures: {} },
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
