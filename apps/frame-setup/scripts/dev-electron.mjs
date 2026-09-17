import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 5174, strictPort: true } });
await server.listen();
const env = { ...process.env, FRAME_SETUP_DEV: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root], { stdio: "inherit", env, windowsHide: true });
child.on("error", async (error) => {
  console.error(error.message);
  await server.close();
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  await server.close();
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill());
}
