import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { TodayController } from "../dist/controller.js";
import { attachTodaySockets } from "../dist/viewer-feedback.js";

test("viewer feedback follows real socket connections and selections without granting command access", async () => {
  const date = "2026-09-08";
  const photos = ["first", "second"].map((base) => ({
    base, date_folder: date, filename: `${base}.jpg`, thumbnail_url: `/${base}.webp`,
    width: 600, height: 400, orientation: 0, processed_at: date, camera_text: "", exif: {},
  }));
  const store = {
    readLatest: async () => ({ date_folder: date, latest_base: "second", updated_at: date, count_today: photos.length }),
    listPhotos: async () => photos,
  };
  const controller = new TodayController(store, 10_000, 60_000);
  await controller.init();
  const server = createServer();
  const closeSockets = attachTodaySockets(server, controller, { username: "test", password: "secret", realm: "test" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = `ws://127.0.0.1:${server.address().port}/today/ws/`;
  const connections = [];
  const connect = (role) => {
    const socket = new WebSocket(address + role, role === "control" ? { headers: { Authorization: `Basic ${Buffer.from("test:secret").toString("base64")}` } } : {});
    const messages = [];
    const received = [];
    const pending = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      const index = pending.findIndex(({ match }) => match(message));
      if (index < 0) messages.push(message);
      else pending.splice(index, 1)[0].resolve(message);
    });
    connections.push(socket);
    return {
      socket,
      received,
      next(match) {
        const index = messages.findIndex(match);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timed out waiting for socket feedback.")), 2_000);
          pending.push({ match, resolve: (value) => { clearTimeout(timer); resolve(value); } });
        });
      },
    };
  };
  const status = (client, counts) => client.next((message) => message.type === "VIEWER_STATUS" && Object.entries(counts).every(([key, value]) => message[key] === value));
  const report = (client, photo_key, value) => client.socket.send(JSON.stringify({ type: "VIEWER_REPORT", photo_key, status: value }));
  try {
    const remote = connect("control");
    await status(remote, { viewers: 0, displayed: 0, loading: 0 });
    const viewer = connect("viewer");
    await viewer.next((message) => message.type === "STATE");
    await status(remote, { viewers: 1, displayed: 0, loading: 1 });
    report(viewer, `${date}/second`, "displayed");
    await status(remote, { viewers: 1, displayed: 1, loading: 0 });

    const secondViewer = connect("viewer");
    await secondViewer.next((message) => message.type === "STATE");
    await status(remote, { viewers: 2, displayed: 1, loading: 1 });
    report(secondViewer, `${date}/second`, "error");
    await status(remote, { viewers: 2, displayed: 1, loading: 0, failed: 1 });

    remote.socket.send(JSON.stringify({ type: "GOTO_INDEX", index: 0 }));
    await status(remote, { photo_key: `${date}/first`, viewers: 2, displayed: 0, loading: 2, failed: 0 });
    const before = controller.state().revision;
    const feedbackStart = remote.received.length;
    viewer.socket.send("not json");
    viewer.socket.send(JSON.stringify({ type: "GOTO_INDEX", index: 1 }));
    report(viewer, `${date}/second`, "displayed");
    report(viewer, `${date}/first`, "empty");
    report(viewer, `${date}/first`, "<script>bad</script>");
    viewer.socket.send(JSON.stringify({ type: "VIEWER_REPORT", photo_key: `${date}/first`, status: "displayed", unexpected: true }));
    report(viewer, `${date}/first`, "loading");
    await status(remote, { photo_key: `${date}/first`, viewers: 2, displayed: 0, loading: 2, failed: 0 });
    assert.deepEqual(remote.received.slice(feedbackStart).map((message) => message.type), ["VIEWER_STATUS"], "only the one valid report should produce feedback, never another STATE");
    assert.equal(controller.state().revision, before, "public reports and commands must not change playback state");
    assert.equal(controller.state().current_base, "first");
    report(viewer, `${date}/first`, "displayed");
    await status(remote, { viewers: 2, displayed: 1, loading: 1 });
    secondViewer.socket.close();
    await status(remote, { viewers: 1, displayed: 1, loading: 0, failed: 0 });

    const reconnectedRemote = connect("control");
    await status(reconnectedRemote, { viewers: 1, displayed: 1, photo_key: `${date}/first` });
    const oversized = connect("viewer");
    await oversized.next((message) => message.type === "STATE");
    oversized.socket.send("x".repeat(1025));
    assert.equal((await once(oversized.socket, "close"))[0], 1009);
    viewer.socket.close();
    await status(remote, { viewers: 0, displayed: 0, loading: 0 });

    const unauthorized = new WebSocket(address + "control");
    const [error] = await once(unauthorized, "error");
    assert.match(error.message, /401/);

    photos.length = 0;
    await controller.refresh(true);
    await status(remote, { photo_key: null, viewers: 0, displayed: 0, loading: 0, failed: 0 });
    const emptyViewer = connect("viewer");
    await emptyViewer.next((message) => message.type === "STATE");
    await status(remote, { photo_key: null, viewers: 1, displayed: 0, loading: 0, failed: 0 });
    report(emptyViewer, null, "displayed");
    report(emptyViewer, null, "empty");
    await status(remote, { photo_key: null, viewers: 1, displayed: 0, loading: 0, failed: 0 });
  } finally {
    for (const socket of connections) socket.terminate();
    controller.close();
    closeSockets();
    await new Promise((resolve) => server.close(resolve));
  }
});
