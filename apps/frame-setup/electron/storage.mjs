import * as nodeFs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// An advisory, not a measured minimum for FRAME or Docker image storage.
export const LOW_SPACE_BYTES = 10 * 1024 ** 3;
const under = (target, parent) => target === parent || target.startsWith(parent === "/" ? "/" : `${parent}/`);
const unescapeMount = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const networkFilesystems = new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "afpfs", "webdav", "davfs", "fuse.sshfs"]);
const localFilesystems = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "f2fs", "tmpfs", "overlay"]);

async function storageType(location, { platform, run, fs, disk }) {
  if (platform === "win32") {
    if (/^\\\\(?![?.]\\)/.test(location)) return { networkKind: "network" };
    try {
      // DriveInfo also identifies mapped network drives. Paths never enter PowerShell code.
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; [System.IO.DriveInfo]::GetDrives() | ForEach-Object { [pscustomobject]@{ root=$_.Name; type=[string]$_.DriveType; ready=$_.IsReady } } | ConvertTo-Json -Compress"], { timeout: 10_000, platform });
      const drives = JSON.parse(stdout);
      const drive = [].concat(drives).find((entry) => entry?.root?.toLowerCase() === path.win32.parse(location).root.toLowerCase());
      if (drive?.ready === false || drive?.type === "NoRootDirectory") return { networkKind: "unknown", missing: true };
      return { networkKind: drive?.type === "Network" ? "network" : ["Fixed", "Removable", "Ram", "CDRom"].includes(drive?.type) ? "local" : "unknown" };
    } catch { return { networkKind: "unknown" }; }
  }

  let mounts;
  try {
    if (platform === "linux") {
      mounts = (await fs.readFile("/proc/self/mountinfo", "utf8")).trim().split("\n").flatMap((line) => {
        const [left, right] = line.split(" - "), fields = left.split(" ");
        return right && fields[4] ? [{ root: unescapeMount(fields[4]), type: right.split(" ")[0] }] : [];
      });
    } else if (platform === "darwin") {
      // Apple's mount prints statfs mount points, filesystem types, and the MNT_LOCAL flag.
      // https://github.com/apple-oss-distributions/diskdev_cmds/blob/main/mount.tproj/mount.c
      const { stdout } = await run("/sbin/mount", [], { timeout: 10_000, platform });
      mounts = stdout.split("\n").flatMap((line) => {
        const match = /^.+ on (\/.*) \(([^\n]+)\)$/.exec(line);
        if (!match) return [];
        const options = match[2].split(", ");
        return [{ root: match[1], type: options[0], local: options.includes("local") }];
      });
    }
  } catch { /* Classification is advisory when native inventory is unavailable. */ }

  if (mounts?.length) {
    const mount = mounts.filter((entry) => under(location, entry.root)).sort((a, b) => b.root.length - a.root.length)[0];
    const removable = platform === "darwin" ? /^\/Volumes\// : /^\/(?:media|run\/media)\//;
    if (removable.test(location) && (!mount || !removable.test(`${mount.root}/`))) return { networkKind: "unknown", missing: true };
    if (platform === "linux") {
      const fstab = await fs.readFile("/etc/fstab", "utf8").catch(() => "");
      const configured = fstab.split("\n").filter((line) => !/^\s*(?:#|$)/.test(line))
        .map((line) => unescapeMount(line.trim().split(/\s+/)[1] || "")).filter((root) => root.startsWith("/") && under(location, root));
      if (configured.some((root) => !mounts.some((entry) => entry.root === root))) return { networkKind: "unknown", missing: true };
    }
    if (mount) {
      if (networkFilesystems.has(mount.type)) return { networkKind: "network" };
      if (platform === "darwin" ? mount.local : localFilesystems.has(mount.type)) return { networkKind: "local" };
    }
  }
  // Linux filesystem magic is useful if mountinfo cannot be read; unknown/FUSE stays unknown.
  if (platform === "linux" && [0x6969, 0x517b, 0xff534d42, 0xfe534d42].includes(Number(disk?.type) >>> 0)) return { networkKind: "network" };
  return { networkKind: "unknown" };
}

/** Caller validates the path with safePath and guards missing existing-install data before this probe. */
export async function checkHostStorage(location, label, { platform = process.platform, run, requiredBytes = 0, fs = nodeFs } = {}) {
  const result = { label, status: "bad", detail: "", availableBytes: null, networkKind: "unknown" };
  const paths = platform === "win32" ? path.win32 : path.posix;
  let phase = "read";
  try {
    if (typeof location !== "string" || !paths.isAbsolute(location) || /[\r\n\0]/.test(location)
      || !Number.isFinite(requiredBytes) || requiredBytes < 0) {
      return { ...result, detail: "Choose an absolute storage folder and a valid space requirement." };
    }
    location = paths.resolve(location);
    let parent = location;
    while (true) {
      const info = await fs.stat(parent).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (info) {
        if (!info.isDirectory()) return { ...result, detail: "The selected storage path is not a folder." };
        break;
      }
      const next = paths.dirname(parent);
      if (next === parent) return { ...result, detail: "The selected drive or share is unavailable. Reconnect it and retry." };
      parent = next;
    }
    const disk = await fs.statfs(parent).catch(() => null);
    const bytes = disk ? Number(disk.bavail) * Number(disk.bsize) : NaN;
    if (Number.isFinite(bytes) && bytes >= 0 && Number(disk.bsize) > 0) result.availableBytes = bytes;
    const storage = await storageType(location, { platform, run, fs, disk });
    result.networkKind = storage.networkKind;
    if (storage.missing) return { ...result, detail: "The selected drive or share is not mounted. Reconnect it and retry." };
    if (result.availableBytes === 0) return { ...result, detail: "The selected storage has no available space. Free space and retry." };
    if (result.availableBytes !== null && result.availableBytes < requiredBytes) {
      return { ...result, detail: `The selected storage has ${Math.floor(result.availableBytes)} bytes available; this operation requires ${Math.ceil(requiredBytes)} bytes.` };
    }

    // Exclusive creation prevents overwriting any existing file; only our own probe is removed.
    const probe = paths.join(parent, `.frame-storage-check-${randomUUID()}.tmp`);
    let handle;
    phase = "write";
    try {
      handle = await fs.open(probe, "wx", 0o600);
      await handle.writeFile(Buffer.from([0]));
      await handle.sync();
    } finally {
      if (handle) {
        try { await handle.close(); }
        finally { phase = "cleanup"; await fs.unlink(probe); phase = "write"; }
      }
    }

    const warnings = [];
    if (result.networkKind === "network") warnings.push("Network storage detected. Keep the connection available; latency and file locking may affect FRAME.");
    else if (result.networkKind === "unknown") warnings.push("Storage type could not be identified; confirm this location stays available.");
    if (result.availableBytes === null) warnings.push("Available space could not be measured.");
    else if (result.availableBytes < LOW_SPACE_BYTES) warnings.push("Less than 10 GiB is available. You can continue, but allow extra room for photos and media.");
    const capacity = result.availableBytes === null ? "" : ` ${(result.availableBytes / 1024 ** 3).toFixed(1)} GiB available.`;
    return { ...result, status: warnings.length ? "warn" : "good", detail: `Write check passed.${capacity}${warnings.length ? ` ${warnings.join(" ")}` : ""}` };
  } catch (error) {
    const details = {
      EACCES: "Permission denied. Choose a writable storage folder or update its permissions.",
      EPERM: "Permission denied. Choose a writable storage folder or update its permissions.",
      EROFS: "The selected storage is read-only. Choose writable storage.",
      ENOSPC: "The selected storage is full. Free space and retry.",
      EDQUOT: "The storage quota is full. Free space or increase the quota and retry.",
      ENOENT: "The selected drive or folder became unavailable. Reconnect it and retry.",
      ENODEV: "The selected drive is unavailable. Reconnect it and retry.",
      ENOTDIR: "The selected storage path is not a folder.",
    };
    return { ...result, detail: phase === "cleanup" ? "Could not finish and clean up the temporary write check. Check storage permissions and availability, then retry."
      : details[error?.code] || "Could not verify storage access. Check the folder, drive connection, and permissions, then retry." };
  }
}

/** Only classic local Linux overlay2 keeps its image storage at DockerRootDir. */
export async function checkDockerStorage(engineInfo, { platform = process.platform, fs = nodeFs } = {}) {
  const result = { label: "Docker image storage", status: "warn", availableBytes: null,
    detail: "Docker image capacity could not be measured reliably. The selected images' installation space requirement is unknown. Check Docker's storage allocation and allow room for image downloads, extraction, and container data." };
  // Containerd can store image data outside DockerRootDir; Desktop owns a separate disk image.
  // https://docs.docker.com/engine/storage/containerd/
  const root = engineInfo?.DockerRootDir;
  if (platform !== "linux" || typeof engineInfo?.OperatingSystem !== "string" || !engineInfo.OperatingSystem
    || /docker desktop/i.test(engineInfo.OperatingSystem) || engineInfo.Driver !== "overlay2"
    || /containerd|snapshotter/i.test(JSON.stringify(engineInfo.DriverStatus ?? []))
    || typeof root !== "string" || !path.posix.isAbsolute(root) || /[\r\n\0]/.test(root)) return result;
  try {
    if (!(await fs.stat(root)).isDirectory()) return result;
    const disk = await fs.statfs(root), bytes = Number(disk.bavail) * Number(disk.bsize);
    if (!Number.isFinite(bytes) || bytes < 0 || Number(disk.bsize) <= 0) return result;
    result.availableBytes = bytes;
    if (bytes === 0) return { ...result, status: "bad", detail: "Docker image storage has no available space. Free space and retry. The selected images' installation space requirement is unknown." };
    return { ...result, detail: `${(bytes / 1024 ** 3).toFixed(1)} GiB is available on Docker's image storage filesystem. ${bytes < LOW_SPACE_BYTES
      ? "Less than 10 GiB is available. " : ""}The selected images' installation space requirement is unknown. Check Docker's storage allocation and allow room for image downloads, extraction, and container data.` };
  } catch { return result; }
}
