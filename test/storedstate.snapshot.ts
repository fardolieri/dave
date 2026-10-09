// The saved-state snapshot (src/core/storedstate.ts): per stored key, what a read gives with nothing stored, the
// shape its parser returns, and what each fixture parses to. test/storedstate.test.ts checks it, and its failure
// message says when and how to change this file. One line per key, as the test prints it.
export const STORED_STATE: Record<string, unknown> = {
  "localStorage dave.name": {"default":null,"shape":"string","fixtures":{"2026-09-06":"Daniel"}},
  "localStorage dave.picture": {"default":null,"shape":"string","fixtures":{"2026-09-10":"🦕"}},
  "localStorage dave.seenKeys": {"default":{},"shape":{"<key>":{"name":"string","nick?":"string","since":"number"}},"fixtures":{"2026-09-06, seen keys":{"pkA":{"name":"Anna","since":1757160000000}},"2026-09-09, nicknames":{"pkA":{"name":"Anna","since":1757160000000,"nick":"Annie"},"pkB":{"name":"Ben","since":1757419200000}}}},
  "localStorage dave.rooms": {"default":[],"shape":[{"addedAt":"number","name":"string","secret":"string"}],"fixtures":{"2026-09-16, rooms":[{"secret":"s3cr3t","name":"Friends","addedAt":1757930000000},{"secret":"0th3r","name":"Gaming","addedAt":1757940000000}]}},
  "localStorage dave.room": {"default":null,"shape":"string","fixtures":{"2026-09-16, rooms":"s3cr3t"}},
  "localStorage dave.secret": {"default":null,"shape":"string","fixtures":{"2026-09-06":"s3cr3t"}},
  "localStorage dave.emojiRecent": {"default":[],"shape":["string"],"fixtures":{"2026-09-10":["🎉","😀"]}},
  "localStorage dave.test": {"default":false,"shape":"boolean","fixtures":{"2026-09-10, e2e seed":true}},
  "localStorage dave.telemetry": {"default":null,"shape":"string","fixtures":{"2026-09-27, yes":"on","2026-09-27, no":"off"}},
  "localStorage dave.muted": {"default":false,"shape":"boolean","fixtures":{"2026-09-06, muted":true,"2026-09-06, unmuted":false}},
  "localStorage dave.rejoin": {"default":null,"shape":{"at":"number","room":"string","watching":["string"]},"fixtures":{"2026-09-24, rejoin":{"room":"roomId","at":1758700000000,"watching":["pkB"]}}},
  "localStorage dave.shareSettings": {"default":{"frameRate":60,"maxHeight":0,"degradation":"maintain-resolution","budgetBps":20000000,"ceilingBps":6000000},"shape":{"budgetBps":"number","ceilingBps":"number","degradation":"string","frameRate":"number","maxHeight":"number"},"fixtures":{"2026-09-06, profiles":{"frameRate":30,"maxHeight":0,"degradation":"maintain-resolution","budgetBps":8000000,"ceilingBps":2500000},"2026-09-23, no profiles":{"frameRate":30,"maxHeight":0,"degradation":"maintain-resolution","budgetBps":20000000,"ceilingBps":6000000}}},
  "localStorage dave.volumes": {"default":{},"shape":{"<key>":"number"},"fixtures":{"2026-09-07":{"pkA":0.5,"pkB":2}}},
  "localStorage dave.shareVolumes": {"default":{},"shape":{"<key>":"number"},"fixtures":{"2026-10-05":{"pkA":0,"pkB":1.5}}},
  "localStorage dave.audioSettings": {"default":{"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true,"microphoneId":"","speakerId":"","masterVolume":1,"noiseRemoval":true,"voiceThreshold":0.5,"lowBandwidthVoice":false,"voiceRepair":"fec"},"shape":{"autoGainControl":"boolean","echoCancellation":"boolean","lowBandwidthVoice":"boolean","masterVolume":"number","microphoneId":"string","noiseRemoval":"boolean","noiseSuppression":"boolean","speakerId":"string","voiceRepair":"string","voiceThreshold":"number"},"fixtures":{"2026-09-06, devices":{"echoCancellation":true,"noiseSuppression":false,"autoGainControl":true,"microphoneId":"mic1","speakerId":"","masterVolume":1,"noiseRemoval":true,"voiceThreshold":0.5,"lowBandwidthVoice":false,"voiceRepair":"fec"},"2026-09-22, master volume":{"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true,"microphoneId":"","speakerId":"spk1","masterVolume":1.5,"noiseRemoval":true,"voiceThreshold":0.5,"lowBandwidthVoice":false,"voiceRepair":"fec"},"2026-09-28, voice repair":{"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true,"microphoneId":"","speakerId":"","masterVolume":1,"noiseRemoval":false,"voiceThreshold":0.3,"lowBandwidthVoice":true,"voiceRepair":"red"}}},
  "localStorage dave.viewerSettings": {"default":{"jitterBufferTargetMs":0},"shape":{"jitterBufferTargetMs":"number"},"fixtures":{"2026-09-06, low latency":{"jitterBufferTargetMs":100}}},
  "IndexedDB identity": "not parsed",
  "IndexedDB history:<roomId>": {"default":[],"shape":[{"at":"number","from":{"fingerprint":"string","name":"string","picture":"string","publicKey":"string"},"text":"string"}],"fixtures":{"2026-09-16, with reconnect notes":[{"from":{"publicKey":"pkA","fingerprint":"ABC123","name":"Anna"},"text":"hi","at":1757500000000}],"2026-09-20, texts only":[{"from":{"publicKey":"pkA","fingerprint":"ABC123","name":"Anna","picture":"🦕"},"text":"hi","at":1758300000000}]}},
  "IndexedDB history": {"default":[],"shape":[{"at":"number","from":{"fingerprint":"string","name":"string","publicKey":"string"},"text":"string"}],"fixtures":{"2026-09-08, before rooms":[{"from":{"publicKey":"pkA","fingerprint":"ABC123","name":"Anna"},"text":"hi","at":1757500000000}]}},
  "sessionStorage dave.tabHeld": "not parsed",
  "sessionStorage dave.update-taken": "not parsed",
  "sessionStorage dave.update-taken-ms": "not parsed",
};
