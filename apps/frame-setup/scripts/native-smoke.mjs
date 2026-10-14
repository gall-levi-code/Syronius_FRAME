import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const base = await realpath(os.tmpdir());
const temporary = await mkdtemp(path.join(base, "frame-native-smoke-"));
const env = { ...process.env, FRAME_SMOKE_ROOT: temporary, FRAME_EXPECTED_ARCH: process.env.FRAME_EXPECTED_ARCH || process.arch };
delete env.ELECTRON_RUN_AS_NODE;
try {
  process.exitCode = await new Promise((resolve, reject) => {
    // This is a native window/focus test; its Electron window must be visible.
    const child = spawn(electron, [fileURLToPath(new URL("../../../tests/electron-native-smoke.cjs", import.meta.url))], { env, stdio: "inherit" });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Native smoke did not exit within 45 seconds.")); }, 45_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolve(code ?? 1); });
  });
} finally {
  if (path.dirname(temporary) !== base || !path.basename(temporary).startsWith("frame-native-smoke-")) throw new Error("Refusing to clean an unexpected smoke directory.");
  // Windows releases Chromium profile locks only after Electron has exited.
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
