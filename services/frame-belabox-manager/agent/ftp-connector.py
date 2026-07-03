#!/usr/bin/env python3
import ftplib
import hashlib
import http.client
import threading
import json
import os
import shutil
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UPLOAD_DIR = Path(os.environ.get("FRAME_FTP_UPLOAD_DIR", "/home/nikonftp/uploads"))
READY_DIR = Path(os.environ.get("FRAME_FTP_READY_DIR", "/home/nikonftp/ready"))
INFLIGHT_DIR = Path(os.environ.get("FRAME_FTP_INFLIGHT_DIR", str(Path.home() / ".frame-belabox-agent/photo-spool/inflight")))
STATUS_PATH = Path(os.environ.get("FRAME_FTP_STATUS_PATH", str(Path.home() / ".frame-belabox-agent/ftp-connector/status.json")))
CONFIG_PATH = Path(os.environ.get("FRAME_PHOTO_CONFIG_PATH", str(Path.home() / ".frame-belabox-agent/photo-config.json")))
TRANSFER_MODE = os.environ.get("FRAME_PHOTO_TRANSFER_MODE", "direct_ftp")
CHUNK_UPLOAD_URL = os.environ.get("FRAME_CHUNK_UPLOAD_URL", "")
CHUNK_UPLOAD_TOKEN = os.environ.get("FRAME_CHUNK_UPLOAD_TOKEN", "")
CHUNK_SIZE_BYTES = max(262144, int(os.environ.get("FRAME_CHUNK_SIZE_BYTES", str(4 * 1024 * 1024))))
HOST = os.environ.get("FRAME_FTP_HOST", "")
PORT = int(os.environ.get("FRAME_FTP_PORT", "2121"))
USERNAME = os.environ.get("FRAME_FTP_USERNAME", "")
PASSWORD = os.environ.get("FRAME_FTP_PASSWORD", "")
REMOTE_DIR = os.environ.get("FRAME_FTP_REMOTE_DIR", "/")
CAMERA_USERNAME = os.environ.get("FRAME_CAMERA_FTP_USERNAME", "framecam")
CAMERA_PASSWORD = os.environ.get("FRAME_CAMERA_FTP_PASSWORD", "")
CAMERA_HOST = os.environ.get("FRAME_CAMERA_FTP_HOST", "0.0.0.0")
CAMERA_PORT = int(os.environ.get("FRAME_CAMERA_FTP_PORT", "2121"))
STABLE_SECONDS = max(1, int(os.environ.get("FRAME_FTP_STABLE_SECONDS", "3")))
IDLE_SECONDS = max(1, int(os.environ.get("FRAME_FTP_IDLE_SECONDS", "1")))
RETRY_SECONDS = max(1, int(os.environ.get("FRAME_FTP_RETRY_SECONDS", "10")))
PROGRESS_BLOCK_BYTES = max(65536, int(os.environ.get("FRAME_CHUNK_PROGRESS_BYTES", str(256 * 1024))))
EXTENSIONS = {".jpg", ".jpeg", ".png"}

last_completed_at = None
last_error = None


def iso_now():
    return datetime.now(timezone.utc).isoformat()


def photo_config():
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            config = json.load(handle)
        return config if isinstance(config, dict) else {}
    except Exception:
        return {}


def transfer_mode():
    mode = str(photo_config().get("transfer_mode") or TRANSFER_MODE)
    return mode if mode in {"direct_ftp", "chunked_https"} else "direct_ftp"


def chunk_size_bytes():
    value = photo_config().get("chunk_size_bytes", CHUNK_SIZE_BYTES)
    try:
        parsed = int(value)
        return min(max(parsed, 262144), 64 * 1024 * 1024)
    except Exception:
        return CHUNK_SIZE_BYTES


def write_status(**status):
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "enabled": True,
        "state": "idle",
        "status_text": "Idle",
        "file": None,
        "size_bytes": 0,
        "sent_bytes": 0,
        "percent": 0,
        "elapsed": 0,
        "rate_bps": 0,
        "done": False,
        "queue_count": queue_count(),
        "transfer_mode": photo_config().get("transfer_mode", TRANSFER_MODE),
        "transport": photo_config().get("transfer_mode", TRANSFER_MODE),
        "camera_ftp": {
            "host": CAMERA_HOST,
            "port": CAMERA_PORT,
            "username": CAMERA_USERNAME,
            "password_configured": bool(CAMERA_PASSWORD),
            "upload_dir": str(UPLOAD_DIR),
        },
        "spool": {
            "incoming": str(UPLOAD_DIR),
            "ready": str(READY_DIR),
            "inflight": str(INFLIGHT_DIR),
        },
        "started_at": None,
        "updated_at": iso_now(),
        "last_completed_at": last_completed_at,
        "last_error": last_error,
    }
    payload.update(status)
    fd, tmp = tempfile.mkstemp(prefix=".status-", dir=str(STATUS_PATH.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")
    os.replace(tmp, STATUS_PATH)


def queue_count():
    return len(list_images(UPLOAD_DIR)) + len(list_images(READY_DIR))


def list_images(directory):
    if not directory.exists():
        return []
    return sorted(path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in EXTENSIONS)


def stage_uploads():
    READY_DIR.mkdir(parents=True, exist_ok=True)
    for path in list_images(UPLOAD_DIR):
        if not is_stable(path):
            continue
        target = unique_ready_path(path.name)
        shutil.move(str(path), str(target))
        info = target.stat()
        write_status(
            state="queued",
            status_text=f"Queued {target.name}",
            file=target.name,
            size_bytes=info.st_size,
            transfer_id=transfer_id_for(target, info),
            queue_count=queue_count(),
        )


def is_stable(path):
    try:
        first = path.stat().st_size
        time.sleep(STABLE_SECONDS)
        return path.exists() and path.stat().st_size == first
    except FileNotFoundError:
        return False


def unique_ready_path(name):
    target = READY_DIR / name
    if not target.exists():
        return target
    stem, suffix = target.stem, target.suffix
    counter = 2
    while True:
        candidate = READY_DIR / f"{stem}-{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def transfer_id_for(path, info=None):
    info = info or path.stat()
    seed = f"{path.name}:{info.st_size}:{getattr(info, 'st_mtime_ns', int(info.st_mtime * 1_000_000_000))}"
    return f"belabox-{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:32]}"


def upload_direct_ftp(path):
    global last_completed_at, last_error
    total = path.stat().st_size
    transfer_id = transfer_id_for(path)
    sent = 0
    started = time.time()
    started_at = iso_now()

    def mark(state, text, **extra):
        elapsed = max(0.0, time.time() - started)
        rate = int(sent / elapsed) if elapsed > 0 and sent > 0 else 0
        percent = min(100.0, (sent / total) * 100) if total > 0 else 0
        write_status(
            state=state,
            status_text=text,
            file=path.name,
            size_bytes=total,
            sent_bytes=sent,
            percent=percent,
            elapsed=elapsed,
            rate_bps=rate,
            started_at=started_at,
            transfer_id=transfer_id,
            **extra,
        )

    def progress(chunk):
        nonlocal sent
        sent += len(chunk)
        mark("uploading", f"Uploading {int(min(100, (sent / total) * 100)) if total else 0}%")

    try:
        last_error = None
        mark("connecting", "Connecting")
        with ftplib.FTP() as ftp:
            ftp.connect(HOST, PORT, timeout=30)
            ftp.login(USERNAME, PASSWORD)
            ftp.set_pasv(True)
            if REMOTE_DIR and REMOTE_DIR != "/":
                ftp.cwd(REMOTE_DIR)
            with path.open("rb") as handle:
                ftp.storbinary(f"STOR {path.name}", handle, blocksize=65536, callback=progress)
        sent = total
        last_completed_at = iso_now()
        mark("complete", "Complete", done=True, last_completed_at=last_completed_at)
        path.unlink(missing_ok=True)
    except Exception as error:
        last_error = str(error)[:160]
        mark("failed", "Retrying", last_error=last_error)
        time.sleep(RETRY_SECONDS)


def upload_chunked(path):
    global last_completed_at, last_error
    if not CHUNK_UPLOAD_URL or not CHUNK_UPLOAD_TOKEN:
        last_error = "Chunk upload URL/token is not configured"
        write_status(state="failed", status_text="Chunk upload not configured", file=path.name, last_error=last_error)
        time.sleep(RETRY_SECONDS)
        return

    total = path.stat().st_size
    chunk_size = chunk_size_bytes()
    chunk_count = max(1, (total + chunk_size - 1) // chunk_size)
    transfer_id = transfer_id_for(path)
    started = time.time()
    started_at = iso_now()
    sent = 0

    def mark(state, text, **extra):
        elapsed = max(0.0, time.time() - started)
        rate = int(sent / elapsed) if elapsed > 0 and sent > 0 else 0
        percent = min(100.0, (sent / total) * 100) if total > 0 else 0
        write_status(
            state=state,
            status_text=text,
            file=path.name,
            size_bytes=total,
            sent_bytes=sent,
            percent=percent,
            elapsed=elapsed,
            rate_bps=rate,
            started_at=started_at,
            transfer_id=transfer_id,
            transfer_mode="chunked_https",
            transport="chunked_https",
            chunk_size_bytes=chunk_size,
            chunk_count=chunk_count,
            **extra,
        )

    try:
        last_error = None
        mark("preparing", "Preparing chunks")
        manifest = build_manifest(path, transfer_id, chunk_size)
        request_json(CHUNK_UPLOAD_URL, "POST", manifest)
        with path.open("rb") as handle:
            for chunk in manifest["chunks"]:
                body = handle.read(chunk["size_bytes"])
                put_url = f"{CHUNK_UPLOAD_URL.rstrip('/')}/{transfer_id}/chunks/{chunk['index']}"
                chunk_start = sent

                def progress(sent_in_chunk):
                    nonlocal sent
                    sent = chunk_start + sent_in_chunk
                    mark("uploading", f"Uploading {int(min(100, (sent / total) * 100)) if total else 0}%")

                request_bytes(put_url, "PUT", body, progress=progress)
                sent = chunk_start + len(body)
                mark("uploading", f"Uploading {int(min(100, (sent / total) * 100)) if total else 0}%")
        mark("assembling", "Assembling on FRAME")
        request_json(f"{CHUNK_UPLOAD_URL.rstrip('/')}/{transfer_id}/complete", "POST", {"device_id": manifest["device_id"]})
        sent = total
        last_completed_at = iso_now()
        mark("complete", "Complete", done=True, last_completed_at=last_completed_at)
        path.unlink(missing_ok=True)
    except Exception as error:
        last_error = str(error)[:160]
        mark("failed", "Retrying", last_error=last_error)
        time.sleep(RETRY_SECONDS)


def build_manifest(path, transfer_id, chunk_size):
    chunks = []
    file_hash = hashlib.sha256()
    index = 0
    with path.open("rb") as handle:
        while True:
            body = handle.read(chunk_size)
            if not body:
                break
            file_hash.update(body)
            chunks.append({
                "index": index,
                "size_bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            })
            index += 1
    return {
        "transfer_id": transfer_id,
        "device_id": os.environ.get("BELABOX_DEVICE_ID", ""),
        "filename": path.name,
        "size_bytes": path.stat().st_size,
        "chunk_size_bytes": chunk_size,
        "chunk_count": len(chunks),
        "file_sha256": file_hash.hexdigest(),
        "chunks": chunks,
    }


def request_json(url, method, payload):
    body = json.dumps(payload).encode("utf-8")
    return request_bytes(url, method, body, "application/json")


def request_bytes(url, method, body, content_type="application/octet-stream", progress=None):
    if progress and method.upper() in {"PUT", "POST"}:
        return request_stream(url, method, body, content_type, progress)
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers=request_headers(content_type, len(body)),
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:120]
        raise RuntimeError(f"chunk upload HTTP {error.code}: {detail}") from error


def request_stream(url, method, body, content_type, progress):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("chunk upload URL must start with http:// or https://")
    path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(parsed.hostname, parsed.port, timeout=60)
    try:
        connection.putrequest(method, path)
        for name, value in request_headers(content_type, len(body)).items():
            connection.putheader(name, value)
        connection.endheaders()
        view = memoryview(body)
        sent = 0
        while sent < len(view):
            next_sent = min(sent + PROGRESS_BLOCK_BYTES, len(view))
            connection.send(view[sent:next_sent])
            sent = next_sent
            progress(sent)
        response = connection.getresponse()
        detail = response.read()
        if response.status >= 400:
            raise RuntimeError(f"chunk upload HTTP {response.status}: {detail.decode('utf-8', 'replace')[:120]}")
        return detail
    finally:
        connection.close()


def request_headers(content_type, length):
    return {
        "Authorization": f"Bearer {CHUNK_UPLOAD_TOKEN}",
        "Content-Type": content_type,
        "Content-Length": str(length),
        "Accept": "application/json",
        "User-Agent": "FRAME-Belabox-Agent/0.5 chunk-uploader",
    }


def start_ftp_receiver():
    try:
        from pyftpdlib.authorizers import DummyAuthorizer
        from pyftpdlib.handlers import FTPHandler
        from pyftpdlib.servers import FTPServer
    except Exception as error:
        write_status(state="failed", status_text="FTP receiver dependency missing", last_error=str(error)[:160])
        raise

    authorizer = DummyAuthorizer()
    authorizer.add_user(CAMERA_USERNAME, CAMERA_PASSWORD, str(UPLOAD_DIR), perm="elradfmwMT")
    handler = FTPHandler
    handler.authorizer = authorizer
    handler.banner = "FRAME Belabox FTP ready"
    server = FTPServer((CAMERA_HOST, CAMERA_PORT), handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"timeout": 1, "blocking": True}, daemon=True)
    thread.start()
    return server


def main():
    if not HOST or not USERNAME or not PASSWORD:
        write_status(state="failed", status_text="Missing FRAME FTP credentials", last_error="FRAME FTP credentials are not configured")
        raise SystemExit(2)
    if not CAMERA_USERNAME or not CAMERA_PASSWORD:
        write_status(state="failed", status_text="Missing camera FTP credentials", last_error="Camera FTP credentials are not configured")
        raise SystemExit(2)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    READY_DIR.mkdir(parents=True, exist_ok=True)
    INFLIGHT_DIR.mkdir(parents=True, exist_ok=True)
    start_ftp_receiver()
    write_status(status_text=f"Camera FTP ready on port {CAMERA_PORT}")
    while True:
        stage_uploads()
        ready = list_images(READY_DIR)
        if ready:
            if transfer_mode() == "chunked_https":
                upload_chunked(ready[0])
            else:
                upload_direct_ftp(ready[0])
        else:
            write_status()
            time.sleep(IDLE_SECONDS)


if __name__ == "__main__":
    main()
