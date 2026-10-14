import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkHostStorage, checkDockerStorage, LOW_SPACE_BYTES } from "../apps/frame-setup/electron/storage.mjs";

const fault = (code) => Object.assign(new Error("private OS diagnostic"), { code });
const rootMount = "1 0 8:1 / / rw - ext4 /dev/root rw\n";
function fixture({ platform = "linux", directories = ["/", "/data"], bytes = LOW_SPACE_BYTES * 2,
  mounts = rootMount, fstab = "", type = 0xef53, failAt, code = "EACCES", run } = {}) {
  const calls = [], files = new Set();
  const fail = (phase) => { if (failAt === phase) throw fault(code); };
  return {
    calls, files,
    options: { platform, run, fs: {
      stat: async (target) => { calls.push(["stat", target]); fail("stat"); if (!directories.includes(target)) throw fault("ENOENT"); return { isDirectory: () => true }; },
      statfs: async () => { fail("statfs"); return { bavail: bytes, bsize: 1, type }; },
      readFile: async (file) => { fail("readFile"); return file === "/proc/self/mountinfo" ? mounts : fstab; },
      open: async (file, flag, mode) => {
        calls.push(["open", file, flag, mode]); fail("open"); files.add(file);
        return {
          writeFile: async (data) => { calls.push(["write", [...data]]); fail("write"); },
          sync: async () => { fail("sync"); }, close: async () => { calls.push(["close"]); fail("close"); },
        };
      },
      unlink: async (file) => { calls.push(["unlink", file]); fail("unlink"); files.delete(file); },
    } },
  };
}

test("new folders probe their nearest existing parent with an exclusive one-byte write and cleanup", async () => {
  const f = fixture();
  const result = await checkHostStorage("/data/new/nested", "FRAME data", f.options);
  assert.equal(result.status, "good");
  assert.equal(result.availableBytes, LOW_SPACE_BYTES * 2);
  assert.equal(result.networkKind, "local");
  assert.match(f.calls.find(([action]) => action === "open")[1], /^\/data\/\.frame-storage-check-.+\.tmp$/);
  assert.deepEqual(f.calls.find(([action]) => action === "open").slice(2), ["wx", 0o600]);
  assert.deepEqual(f.calls.find(([action]) => action === "write"), ["write", [0]]);
  assert.equal(f.files.size, 0);
});

test("real host write check leaves no files and does not create the planned folder", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frame-storage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = await checkHostStorage(path.join(directory, "new", "data"), "FRAME data");
  assert.notEqual(result.status, "bad");
  assert.ok(result.availableBytes > 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("permission, read-only, full, and quota failures block without leaking OS diagnostics; failed writes are cleaned up", async () => {
  for (const [code, pattern] of [["EACCES", /Permission/], ["EROFS", /read-only/], ["ENOSPC", /full/], ["EDQUOT", /quota/]]) {
    const f = fixture({ failAt: "open", code });
    const result = await checkHostStorage("/data", "Storage", f.options);
    assert.equal(result.status, "bad"); assert.match(result.detail, pattern);
    assert.doesNotMatch(result.detail, /private OS/);
    assert.equal(f.calls.some(([action]) => action === "unlink"), false, "never delete a file we did not create");
  }
  const partial = fixture({ failAt: "write", code: "ENOSPC" });
  assert.equal((await checkHostStorage("/data", "Storage", partial.options)).status, "bad");
  assert.equal(partial.files.size, 0);
  const cleanup = fixture({ failAt: "unlink" });
  assert.match((await checkHostStorage("/data", "Storage", cleanup.options)).detail, /clean up/);
});

test("zero and known payload shortages block; low or unmeasurable capacity only warns", async () => {
  for (const [bytes, requiredBytes, status] of [[0, 0, "bad"], [100, 101, "bad"], [100, 100, "warn"], [LOW_SPACE_BYTES, 0, "good"], [-1, 0, "warn"]]) {
    const f = fixture({ bytes });
    const result = await checkHostStorage("/data", "Storage", { ...f.options, requiredBytes });
    assert.equal(result.status, status);
    if (status === "bad") assert.equal(f.calls.some(([action]) => action === "open"), false);
    if (bytes < 0) assert.equal(result.availableBytes, null);
    if (bytes === 100 && status === "warn") assert.match(result.detail, /You can continue, but allow extra room for photos and media/);
  }
  assert.equal((await checkHostStorage("/data", "Storage", fixture({ failAt: "statfs" }).options)).status, "warn");
});

test("Windows accepts internal and USB drives, warns for mapped drives/UNC/unknown, and blocks missing drives", async () => {
  for (const [type, networkKind] of [["Fixed", "local"], ["Removable", "local"], ["Network", "network"], ["Unknown", "unknown"]]) {
    const run = async (command, args) => {
      assert.equal(command, "powershell.exe"); assert.ok(args.includes("-NonInteractive"));
      return { stdout: JSON.stringify({ root: "E:\\", type, ready: true }) };
    };
    const f = fixture({ platform: "win32", directories: ["E:\\"], run });
    const result = await checkHostStorage("E:\\FRAME Data", "Storage", f.options);
    assert.equal(result.networkKind, networkKind);
    assert.equal(result.status, networkKind === "local" ? "good" : "warn");
  }
  const unc = fixture({ platform: "win32", directories: ["\\\\server\\share\\"] });
  assert.equal((await checkHostStorage("\\\\server\\share\\data", "Storage", unc.options)).networkKind, "network");
  const missing = fixture({ platform: "win32", directories: [] });
  assert.match((await checkHostStorage("Z:\\FRAME Data", "Storage", missing.options)).detail, /unavailable/);
  assert.equal(missing.calls.some(([action]) => action === "open"), false);
});

test("Linux mount inventory detects network filesystems, escaped mount paths, and known disconnected mounts", async () => {
  for (const type of ["nfs4", "cifs", "fuse.sshfs"]) {
    const f = fixture({ mounts: `${rootMount}2 1 0:1 / /data rw - ${type} server:/share rw\n` });
    const result = await checkHostStorage("/data/frame", "Storage", f.options);
    assert.equal(result.networkKind, "network"); assert.equal(result.status, "warn");
  }
  const mounted = fixture({ directories: ["/", "/media/user/USB Disk"], mounts: `${rootMount}2 1 8:2 / /media/user/USB\\040Disk rw - exfat /dev/sdb1 rw\n` });
  assert.equal((await checkHostStorage("/media/user/USB Disk/frame", "Storage", mounted.options)).status, "good");
  const disconnected = fixture({ directories: ["/", "/media/user/USB Disk"] });
  assert.match((await checkHostStorage("/media/user/USB Disk/frame", "Storage", disconnected.options)).detail, /not mounted/);
  const known = fixture({ fstab: "UUID=example /mnt/photos ext4 defaults 0 2\n" });
  assert.equal((await checkHostStorage("/mnt/photos/frame", "Storage", known.options)).status, "bad");
  assert.equal((await checkHostStorage("/mnt/newfolder", "Storage", fixture().options)).status, "good");
  const magic = fixture({ failAt: "readFile", type: 0xff534d42 });
  assert.equal((await checkHostStorage("/data", "Storage", magic.options)).networkKind, "network");
});

test("macOS native mount flags distinguish local and network volumes; missing volume blocks and unavailable classification warns", async () => {
  for (const [type, flags, expected] of [["apfs", ", local", "local"], ["exfat", ", local", "local"], ["smbfs", "", "network"], ["unrecognized", "", "unknown"]]) {
    const f = fixture({ platform: "darwin", directories: ["/", "/Volumes/Photo Disk"],
      run: async (command, args) => { assert.equal(command, "/sbin/mount"); assert.deepEqual(args, []); return { stdout: `/dev/disk1 on / (apfs, local)\nsource on /Volumes/Photo Disk (${type}${flags})\n` }; } });
    const result = await checkHostStorage("/Volumes/Photo Disk/frame", "Storage", f.options);
    assert.equal(result.networkKind, expected); assert.equal(result.status, expected === "local" ? "good" : "warn");
  }
  const missing = fixture({ platform: "darwin", directories: ["/", "/Volumes"], run: async () => ({ stdout: "/dev/disk1 on / (apfs, local)\n" }) });
  assert.equal((await checkHostStorage("/Volumes/Missing/frame", "Storage", missing.options)).status, "bad");
  for (const platform of ["darwin", "win32"]) {
    const f = fixture({ platform, directories: platform === "win32" ? ["C:\\"] : ["/"], run: async () => { throw fault("ENOENT"); } });
    assert.equal((await checkHostStorage(platform === "win32" ? "C:\\data" : "/data", "Storage", f.options)).status, "warn");
  }
});

test("Docker capacity is read-only and limited to confirmed classic local Linux image storage", async () => {
  const info = { OperatingSystem: "Ubuntu 24.04", Driver: "overlay2", DriverStatus: [], DockerRootDir: "/var/lib/docker" };
  for (const bytes of [0, 100, LOW_SPACE_BYTES * 2]) {
    const f = fixture({ bytes, directories: ["/var/lib/docker"] });
    const result = await checkDockerStorage(info, f.options);
    assert.equal(result.availableBytes, bytes);
    assert.equal(result.status, bytes === 0 ? "bad" : "warn");
    assert.match(result.detail, /installation space requirement is unknown/);
    if (bytes > 0) assert.match(result.detail, /Check Docker's storage allocation and allow room for image downloads, extraction, and container data/);
    assert.deepEqual(f.calls, [["stat", "/var/lib/docker"]], "no write probe or parent traversal for Docker's storage");
  }
  for (const value of [
    { ...info, OperatingSystem: "Docker Desktop" },
    { ...info, Driver: "overlayfs", DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]] },
    { ...info, DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]] },
    { ...info, DockerRootDir: "relative" },
    { ...info, OperatingSystem: undefined },
  ]) {
    const f = fixture();
    const result = await checkDockerStorage(value, f.options);
    assert.equal(result.status, "warn"); assert.equal(result.availableBytes, null);
    assert.match(result.detail, /Check Docker's storage allocation/);
    assert.deepEqual(f.calls, []);
  }
  for (const platform of ["win32", "darwin"]) {
    const f = fixture({ platform });
    assert.equal((await checkDockerStorage(info, f.options)).availableBytes, null);
    assert.deepEqual(f.calls, []);
  }
  for (const overrides of [{ directories: [] }, { directories: ["/var/lib/docker"], failAt: "statfs" }, { directories: ["/var/lib/docker"], bytes: -1 }]) {
    const f = fixture(overrides);
    assert.equal((await checkDockerStorage(info, f.options)).availableBytes, null);
    assert.deepEqual(f.calls, [["stat", "/var/lib/docker"]]);
  }
});
