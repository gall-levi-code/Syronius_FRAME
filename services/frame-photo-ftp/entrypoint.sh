#!/bin/sh
set -eu

username="${PHOTO_FTP_USERNAME:-frame}"
password="${PHOTO_FTP_PASSWORD:-}"
passive_host="${PHOTO_FTP_PASSIVE_HOST:-127.0.0.1}"
passive_min="${PHOTO_FTP_PASSIVE_MIN:-30000}"
passive_max="${PHOTO_FTP_PASSIVE_MAX:-30009}"

if [ "${#password}" -lt 12 ]; then
  echo "[photo-ftp] PHOTO_FTP_PASSWORD must contain at least 12 characters." >&2
  exit 1
fi

mkdir -p /data/inbox /data/staging
if ! id "$username" >/dev/null 2>&1; then
  addgroup -S frameftp
  adduser -D -H -h /data/inbox -s /bin/sh -G frameftp -u 1001 "$username"
fi
chown -R "$username":frameftp /data/inbox
echo "$username:$password" | chpasswd

pure-ftpd \
  -B \
  -S "0.0.0.0,${PHOTO_FTP_PORT:-2121}" \
  -P "$passive_host" \
  -p "${passive_min}:${passive_max}" \
  -l unix \
  -E \
  -j \
  -R \
  -c 8 \
  -C 2

exec node dist/index.js
