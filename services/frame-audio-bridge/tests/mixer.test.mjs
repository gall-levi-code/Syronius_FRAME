import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { AudioMixer } = require("../dist/voice/mixer.js");
const { DelayBuffer } = require("../dist/voice/delayBuffer.js");

const FRAME_BYTES = 48_000 / 1_000 * 20 * 2 * 2;

test("mixer waits for jitter priming, applies volume, and emits stereo PCM", () => {
  const mixer = new AudioMixer();
  const user = sessionUser("user-1", { volume: 0.5 });

  for (let frame = 0; frame < 3; frame += 1) {
    mixer.enqueue(pcmFrame("user-1", 1_000, frame));
  }
  assert.equal(mixer.mixNextFrame([user]), null);

  mixer.enqueue(pcmFrame("user-1", 1_000, 3));
  const mixed = mixer.mixNextFrame([user]);

  assert.ok(mixed);
  assert.equal(mixed.sampleRate, 48_000);
  assert.equal(mixed.channels, 2);
  assert.equal(mixed.pcm.length, FRAME_BYTES);
  assert.equal(mixed.pcm.readInt16LE(0), 500);
  assert.equal(mixed.pcm.readInt16LE(2), 500);
});

test("mixer suppresses muted users and soft-limits loud combined samples", () => {
  const mutedMixer = new AudioMixer();
  for (let frame = 0; frame < 4; frame += 1) {
    mutedMixer.enqueue(pcmFrame("muted", 10_000, frame));
  }
  assert.equal(mutedMixer.mixNextFrame([sessionUser("muted", { muted: true })]), null);

  const loudMixer = new AudioMixer();
  for (let frame = 0; frame < 4; frame += 1) {
    loudMixer.enqueue(pcmFrame("left", 30_000, frame));
    loudMixer.enqueue(pcmFrame("right", 30_000, frame));
  }

  const mixed = loudMixer.mixNextFrame([
    sessionUser("left"),
    sessionUser("right"),
  ]);
  assert.ok(mixed);
  assert.equal(mixed.pcm.readInt16LE(0) <= 32_767, true);
  assert.equal(loudMixer.getStats().softLimitedSamples > 0, true);
});

test("delay buffer releases only ready chunks and can be cleared", () => {
  const buffer = new DelayBuffer();
  buffer.push("early", 50, 1_000);
  buffer.push("late", 150, 1_000);

  assert.equal(buffer.popReady(1_025), null);
  assert.equal(buffer.popReady(1_050), "early");
  assert.deepEqual(buffer.drainReady(1_149), []);
  assert.deepEqual(buffer.drainReady(1_150), ["late"]);

  buffer.push("discard", 0, 2_000);
  buffer.clear();
  assert.equal(buffer.popReady(2_000), null);
});

function pcmFrame(discordUserId, sample, sequence) {
  const pcm = Buffer.alloc(FRAME_BYTES);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(sample, offset);
  }
  return {
    discordUserId,
    pcm,
    sampleRate: 48_000,
    channels: 2,
    receivedAt: 1_000 + sequence * 20,
  };
}

function sessionUser(discordUserId, controls = {}) {
  return {
    discordUserId,
    displayName: discordUserId,
    avatarUrl: "",
    speaking: true,
    audioLevel: 0,
    muted: false,
    volume: 1,
    hidden: false,
    ...controls,
  };
}
