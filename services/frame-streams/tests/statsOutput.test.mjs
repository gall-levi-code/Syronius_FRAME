import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStatsOutputFormat,
  renderStatsOutput,
} from "../dist/statsOutput.js";

test("renders BBox receiver stats from normalized FRAME telemetry", () => {
  const result = renderStatsOutput("bbox_receiver", { id: "play_public" }, {
    bitrate: 2500,
    buffer: 120,
    dropped_pkts: 3,
    latency: 80,
    rtt: 42,
    uptime: 3601,
    connected: true,
    source_type: "sls",
    missing_pkts: 7,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "ok");
  assert.deepEqual(Object.keys(result.body.publishers), ["live/stream/play_public"]);
  assert.equal(result.body.publishers["live/stream/play_public"].bitrate, 2500);
  assert.equal(result.body.publishers["live/stream/play_public"].mbpsRecvRate, 2.5);
  assert.equal(result.body.publishers["live/stream/play_public"].pktRcvLoss, 7);
});

test("renders empty BBox publisher map for offline or unavailable stats", () => {
  assert.deepEqual(
    renderStatsOutput("bbox_receiver", { id: "play_public" }, null).body,
    { publishers: {}, status: "ok" },
  );
  assert.deepEqual(
    renderStatsOutput("bbox_receiver", { id: "play_public" }, {
      bitrate: 0,
      buffer: null,
      dropped_pkts: 0,
      latency: null,
      rtt: null,
      uptime: 0,
      connected: false,
      source_type: "custom",
    }).body,
    { publishers: {}, status: "ok" },
  );
});

test("accepts friendly adapter aliases", () => {
  assert.equal(parseStatsOutputFormat("bbox"), "bbox_receiver");
  assert.equal(parseStatsOutputFormat("bbox-receiver"), "bbox_receiver");
  assert.equal(parseStatsOutputFormat("native"), "frame");
  assert.throws(() => parseStatsOutputFormat("banana"));
});
