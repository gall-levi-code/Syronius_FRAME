import assert from "node:assert/strict";
import test from "node:test";
import {
  STATS_OUTPUTS,
  parseStatsOutputFormat,
  renderStatsOutput,
} from "../dist/statsOutput.js";

test("public stats default to SLS compatibility while FRAME remains explicit", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.equal(parseStatsOutputFormat(value), "bbox_receiver");
  }
  assert.equal(parseStatsOutputFormat("frame"), "frame");
  assert.equal(STATS_OUTPUTS[0].id, "bbox_receiver");
  assert.equal(STATS_OUTPUTS[0].query, "");
  assert.equal(STATS_OUTPUTS.find((output) => output.id === "frame").query, "output=frame");
});

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
  assert.equal(parseStatsOutputFormat("belabox"), "belabox");
  assert.throws(() => parseStatsOutputFormat("banana"));
});

test("BELABOX output provides a live publisher for connected and offline feeds", () => {
  const profile = { id: "play_public" };
  const offline = renderStatsOutput("belabox", profile, null).body;
  assert.deepEqual(offline, { publishers: { live: {
    connected: false, latency: 0, network: 0, bitrate: 0, rtt: 0, dropped_pkts: 0,
  } }, consumers: [] });
  const online = renderStatsOutput("belabox", profile, {
    bitrate: 2500, buffer: null, dropped_pkts: 3, latency: 80, rtt: 42, uptime: 60,
    connected: true, source_type: "sls",
  }).body;
  assert.deepEqual(online.publishers.live, {
    connected: true, latency: 80, network: 0, bitrate: 2500, rtt: 42, dropped_pkts: 3,
  });
});

test("SLS numeric fields stay parseable when normalized metrics are fractional or unavailable", () => {
  const { body } = renderStatsOutput("bbox_receiver", { id: "play_public" }, {
    bitrate: 2500.4, buffer: 120.8, dropped_pkts: 3.2, latency: null, rtt: null,
    uptime: 3601.9, connected: true, source_type: "sls",
  });
  const publisher = body.publishers["live/stream/play_public"];
  for (const field of ["bitrate", "pktRcvDrop", "pktRcvLoss", "msRcvBuf", "uptime"]) {
    assert.ok(Number.isInteger(publisher[field]), `${field} must be an integer for SLS readers`);
  }
  assert.equal(publisher.msRcvBuf, 121);
  assert.equal(publisher.rtt, 0);
});
