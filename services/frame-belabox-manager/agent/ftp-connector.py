#!/usr/bin/env python3
import ftplib
import hashlib
import http.client
import threading
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
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
CHUNK_PARALLEL_UPLOADS = min(4, max(1, int(os.environ.get("FRAME_CHUNK_PARALLEL_UPLOADS", "1"))))
CHUNK_UPLOAD_KBPS = min(1000000, max(0, int(os.environ.get("FRAME_CHUNK_UPLOAD_KBPS", "0"))))
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
PROCESSING_DEFAULTS = {
    "enabled": False,
    "long_edge_px": 0,
    "jpeg_quality": 92,
    "max_output_mb": 0,
}
MAX_OUTPUT_DEFAULT_LONG_EDGE = 2400

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


def chunk_parallel_uploads(config=None):
    root = config if isinstance(config, dict) else photo_config()
    return bounded_int(root.get("chunk_parallel_uploads"), CHUNK_PARALLEL_UPLOADS, 1, 4)


def chunk_upload_kbps(config=None):
    root = config if isinstance(config, dict) else photo_config()
    return bounded_int(root.get("chunk_upload_kbps"), CHUNK_UPLOAD_KBPS, 0, 1000000)


def processing_settings(config=None):
    root = config if isinstance(config, dict) else photo_config()
    raw = root.get("image_processing", {})
    source = raw if isinstance(raw, dict) else {}
    max_output_mb = bounded_float(source.get("max_output_mb"), PROCESSING_DEFAULTS["max_output_mb"], 0, 500)
    long_edge_px = bounded_int(source.get("long_edge_px"), PROCESSING_DEFAULTS["long_edge_px"], 0, 12000)
    return {
        "enabled": source.get("enabled") is True,
        "long_edge_px": long_edge_px or (MAX_OUTPUT_DEFAULT_LONG_EDGE if max_output_mb > 0 else 0),
        "jpeg_quality": bounded_int(source.get("jpeg_quality"), PROCESSING_DEFAULTS["jpeg_quality"], 40, 100),
        "max_output_mb": max_output_mb,
    }


def bounded_int(value, fallback, minimum, maximum):
    try:
        parsed = int(value if value is not None else fallback)
        return parsed if minimum <= parsed <= maximum else fallback
    except Exception:
        return fallback


def bounded_float(value, fallback, minimum, maximum):
    try:
        parsed = float(value if value is not None else fallback)
        return round(parsed, 3) if minimum <= parsed <= maximum else fallback
    except Exception:
        return fallback


class RateLimiter:
    def __init__(self, kbps):
        self.bytes_per_second = (kbps * 1000) / 8 if kbps > 0 else 0
        self.started = time.monotonic()
        self.reserved = 0
        self.lock = threading.Lock()

    def wait(self, byte_count):
        if self.bytes_per_second <= 0 or byte_count <= 0:
            return
        with self.lock:
            self.reserved += byte_count
            delay = self.started + (self.reserved / self.bytes_per_second) - time.monotonic()
        if delay > 0:
            time.sleep(delay)


def stream_block_size(rate_limiter=None):
    if rate_limiter and rate_limiter.bytes_per_second > 0:
        return min(PROGRESS_BLOCK_BYTES, max(8192, int(rate_limiter.bytes_per_second / 10)))
    return PROGRESS_BLOCK_BYTES


def image_processor():
    return shutil.which("magick") or shutil.which("convert")


def image_processing_status():
    settings = processing_settings()
    processor = image_processor()
    return {
        **settings,
        "processor": Path(processor).name if processor else None,
    }


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
        "chunk_size_bytes": chunk_size_bytes(),
        "chunk_parallel_uploads": chunk_parallel_uploads(),
        "chunk_upload_kbps": chunk_upload_kbps(),
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
        "image_processing": image_processing_status(),
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
    return sorted(
        (path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in EXTENSIONS),
        key=image_sort_key,
    )


def image_sort_key(path):
    try:
        return (path.stat().st_mtime_ns, path.name.lower())
    except FileNotFoundError:
        return (0, path.name.lower())


def stage_uploads():
    READY_DIR.mkdir(parents=True, exist_ok=True)
    ready_was_empty = not list_images(READY_DIR)
    staged = []
    for path in list_images(UPLOAD_DIR):
        if not is_stable(path):
            continue
        target = unique_ready_path(path.name)
        shutil.move(str(path), str(target))
        info = target.stat()
        staged.append((target, info))
    if ready_was_empty and staged:
        target, info = staged[0]
        write_status(
            state="queued",
            status_text=f"Queued {len(staged)} photo{'s' if len(staged) != 1 else ''}",
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


def upload_name_for(path, settings):
    if settings["enabled"] and path.suffix.lower() == ".png":
        return f"{path.stem}.jpg"
    return path.name


def prepare_upload(path, settings):
    if not settings["enabled"]:
        return path, path.name, None, None
    try:
        processed = process_image(path, settings)
        return processed, upload_name_for(path, settings), processed, None
    except Exception as error:
        return path, path.name, None, f"Image processing skipped: {str(error)[:120]}"


def process_image(path, settings):
    processor = image_processor()
    if not processor:
        raise RuntimeError("ImageMagick is required for pre-transfer image processing; rerun FTP connector repair to install it")

    target = INFLIGHT_DIR / f"{transfer_id_for(path)}.processed.jpg"
    temp_target = INFLIGHT_DIR / f".{target.name}.tmp.jpg"
    max_bytes = int(settings["max_output_mb"] * 1024 * 1024) if settings["max_output_mb"] > 0 else 0
    target.unlink(missing_ok=True)
    temp_target.unlink(missing_ok=True)

    try:
        for quality in quality_steps(settings["jpeg_quality"]):
            temp_target.unlink(missing_ok=True)
            run_imagemagick(processor, path, temp_target, settings, quality)
            os.replace(temp_target, target)
            size = target.stat().st_size
            if not max_bytes or size <= max_bytes:
                return target
            if quality == 40:
                target.unlink(missing_ok=True)
                raise RuntimeError(f"Processed image exceeds {settings['max_output_mb']} MB at minimum quality")
    except Exception:
        temp_target.unlink(missing_ok=True)
        raise
    raise RuntimeError("Unable to process image")


def quality_steps(start):
    quality = start
    while quality >= 40:
        yield quality
        if quality == 40:
            break
        quality = max(40, quality - 5)


def run_imagemagick(processor, source, target, settings, quality):
    command = imagemagick_command(processor, source, target, settings, quality)
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if completed.returncode != 0:
        output = (completed.stderr or completed.stdout).strip()
        if output:
            detail = output.splitlines()[-1]
        elif completed.returncode < 0:
            detail = f"ImageMagick exited by signal {-completed.returncode}"
        else:
            detail = f"ImageMagick failed with exit code {completed.returncode}"
        raise RuntimeError(detail[:160])


def imagemagick_command(processor, source, target, settings, quality):
    command = [processor]
    if settings["long_edge_px"] > 0:
        edge = str(settings["long_edge_px"])
        if source.suffix.lower() in {".jpg", ".jpeg"}:
            command.extend(["-define", f"jpeg:size={edge}x{edge}"])
    command.extend([
        str(source),
        "-auto-orient",
        "-orient",
        "TopLeft",
        "-background",
        "white",
        "-alpha",
        "remove",
        "-alpha",
        "off",
    ])
    if settings["long_edge_px"] > 0:
        edge = str(settings["long_edge_px"])
        command.extend(["-resize", f"{edge}x{edge}>"])
    command.extend(["-quality", str(quality), str(target)])
    return command


def upload_direct_ftp(path):
    global last_completed_at, last_error
    upload_path = path
    upload_name = path.name
    cleanup_path = None
    total = upload_path.stat().st_size
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
            file=upload_name,
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
        settings = processing_settings()
        if settings["enabled"]:
            mark("processing", "Processing image")
        upload_path, upload_name, cleanup_path, processing_warning = prepare_upload(path, settings)
        if processing_warning:
            last_error = processing_warning
            mark("processing", "Processing skipped; uploading original", last_error=last_error)
        total = upload_path.stat().st_size
        mark("connecting", "Connecting")
        with ftplib.FTP() as ftp:
            ftp.connect(HOST, PORT, timeout=30)
            ftp.login(USERNAME, PASSWORD)
            ftp.set_pasv(True)
            if REMOTE_DIR and REMOTE_DIR != "/":
                ftp.cwd(REMOTE_DIR)
            with upload_path.open("rb") as handle:
                ftp.storbinary(f"STOR {upload_name}", handle, blocksize=65536, callback=progress)
        sent = total
        last_completed_at = iso_now()
        mark("complete", "Complete", done=True, last_completed_at=last_completed_at)
        path.unlink(missing_ok=True)
    except Exception as error:
        last_error = str(error)[:160]
        mark("failed", "Retrying", last_error=last_error)
        time.sleep(RETRY_SECONDS)
    finally:
        if cleanup_path and cleanup_path != path:
            cleanup_path.unlink(missing_ok=True)


def upload_chunked(path):
    global last_completed_at, last_error
    if not CHUNK_UPLOAD_URL or not CHUNK_UPLOAD_TOKEN:
        last_error = "Chunk upload URL/token is not configured"
        write_status(state="failed", status_text="Chunk upload not configured", file=path.name, last_error=last_error)
        time.sleep(RETRY_SECONDS)
        return

    upload_path = path
    upload_name = path.name
    cleanup_path = None
    total = upload_path.stat().st_size
    chunk_size = chunk_size_bytes()
    chunk_count = max(1, (total + chunk_size - 1) // chunk_size)
    parallel_limit = chunk_parallel_uploads()
    active_parallel = min(parallel_limit, chunk_count)
    upload_kbps = chunk_upload_kbps()
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
            file=upload_name,
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
            chunk_parallel_uploads=active_parallel,
            chunk_upload_kbps=upload_kbps,
            **extra,
        )

    def uploading_text():
        percent_text = int(min(100, (sent / total) * 100)) if total else 0
        stream_label = "stream" if active_parallel == 1 else "streams"
        cap_text = f", {upload_kbps} kbps cap" if upload_kbps > 0 else ""
        return f"Uploading {percent_text}% ({active_parallel} {stream_label}{cap_text})"

    try:
        last_error = None
        settings = processing_settings()
        if settings["enabled"]:
            mark("processing", "Processing image")
        upload_path, upload_name, cleanup_path, processing_warning = prepare_upload(path, settings)
        if processing_warning:
            last_error = processing_warning
            mark("processing", "Processing skipped; uploading original", last_error=last_error)
        total = upload_path.stat().st_size
        chunk_count = max(1, (total + chunk_size - 1) // chunk_size)
        active_parallel = min(parallel_limit, chunk_count)
        mark("preparing", "Preparing chunks")
        manifest = build_manifest(upload_path, transfer_id, chunk_size, upload_name)
        request_json(CHUNK_UPLOAD_URL, "POST", manifest)
        sent_by_chunk = {}
        progress_lock = threading.Lock()
        limiter = RateLimiter(upload_kbps)

        def progress(chunk_index, sent_in_chunk):
            nonlocal sent
            with progress_lock:
                sent_by_chunk[chunk_index] = sent_in_chunk
                sent = sum(sent_by_chunk.values())
            mark("uploading", uploading_text())

        upload_manifest_chunks(upload_path, transfer_id, manifest, active_parallel, limiter, progress)
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
    finally:
        if cleanup_path and cleanup_path != path:
            cleanup_path.unlink(missing_ok=True)


def build_manifest(path, transfer_id, chunk_size, filename=None):
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
        "filename": filename or path.name,
        "size_bytes": path.stat().st_size,
        "chunk_size_bytes": chunk_size,
        "chunk_count": len(chunks),
        "file_sha256": file_hash.hexdigest(),
        "chunks": chunks,
    }


def chunk_offset(chunk, chunk_size):
    return int(chunk["index"]) * chunk_size


def upload_one_chunk(upload_path, transfer_id, manifest, chunk, rate_limiter, progress):
    with upload_path.open("rb") as handle:
        handle.seek(chunk_offset(chunk, manifest["chunk_size_bytes"]))
        body = handle.read(chunk["size_bytes"])
    if len(body) != chunk["size_bytes"]:
        raise RuntimeError(f"chunk {chunk['index']} expected {chunk['size_bytes']} bytes, read {len(body)}")
    put_url = f"{CHUNK_UPLOAD_URL.rstrip('/')}/{transfer_id}/chunks/{chunk['index']}"
    request_bytes(
        put_url,
        "PUT",
        body,
        progress=lambda sent: progress(chunk["index"], sent),
        rate_limiter=rate_limiter,
    )
    progress(chunk["index"], len(body))


def upload_manifest_chunks(upload_path, transfer_id, manifest, parallel, rate_limiter, progress):
    chunks = manifest["chunks"]
    if parallel <= 1 or len(chunks) <= 1:
        for chunk in chunks:
            upload_one_chunk(upload_path, transfer_id, manifest, chunk, rate_limiter, progress)
        return
    with ThreadPoolExecutor(max_workers=parallel) as executor:
        futures = [
            executor.submit(upload_one_chunk, upload_path, transfer_id, manifest, chunk, rate_limiter, progress)
            for chunk in chunks
        ]
        for future in as_completed(futures):
            future.result()


def request_json(url, method, payload):
    body = json.dumps(payload).encode("utf-8")
    return request_bytes(url, method, body, "application/json")


def request_bytes(url, method, body, content_type="application/octet-stream", progress=None, rate_limiter=None):
    if (progress or rate_limiter) and method.upper() in {"PUT", "POST"}:
        return request_stream(url, method, body, content_type, progress or (lambda _sent: None), rate_limiter)
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


def request_stream(url, method, body, content_type, progress, rate_limiter=None):
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
        block_size = stream_block_size(rate_limiter)
        while sent < len(view):
            next_sent = min(sent + block_size, len(view))
            block = view[sent:next_sent]
            if rate_limiter:
                rate_limiter.wait(len(block))
            connection.send(block)
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


def self_test():
    settings = processing_settings({"image_processing": {
        "enabled": True,
        "long_edge_px": "1600",
        "jpeg_quality": "85",
        "max_output_mb": "2.5",
    }})
    assert settings == {"enabled": True, "long_edge_px": 1600, "jpeg_quality": 85, "max_output_mb": 2.5}
    assert processing_settings({"image_processing": {"long_edge_px": "13000"}})["long_edge_px"] == 0
    assert processing_settings({"image_processing": {"enabled": True, "max_output_mb": "2"}})["long_edge_px"] == MAX_OUTPUT_DEFAULT_LONG_EDGE
    assert upload_name_for(Path("photo.png"), {"enabled": True}) == "photo.jpg"
    assert upload_name_for(Path("photo.jpeg"), {"enabled": True}) == "photo.jpeg"
    assert prepare_upload(Path("photo.jpg"), {"enabled": False}) == (Path("photo.jpg"), "photo.jpg", None, None)
    assert list(quality_steps(47)) == [47, 42, 40]
    command = imagemagick_command("convert", Path("photo.jpg"), Path("out.jpg"), {"long_edge_px": 1600}, 85)
    assert "-resize" in command
    assert "-thumbnail" not in command
    assert command[command.index("-orient") + 1] == "TopLeft"
    assert chunk_parallel_uploads({"chunk_parallel_uploads": "3"}) == 3
    assert chunk_parallel_uploads({"chunk_parallel_uploads": "9"}) == CHUNK_PARALLEL_UPLOADS
    assert chunk_upload_kbps({"chunk_upload_kbps": "512"}) == 512
    assert chunk_upload_kbps({"chunk_upload_kbps": "-1"}) == CHUNK_UPLOAD_KBPS
    assert chunk_offset({"index": 2}, 4096) == 8192
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        older = root / "older.jpg"
        newer = root / "newer.jpg"
        older.write_text("older", encoding="utf-8")
        newer.write_text("newer", encoding="utf-8")
        os.utime(older, (1, 1))
        os.utime(newer, (2, 2))
        assert [path.name for path in list_images(root)] == ["older.jpg", "newer.jpg"]


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        main()
