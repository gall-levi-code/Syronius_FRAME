#!/bin/sh
set -eu

username="${PHOTO_FTP_USERNAME:-frame}"
password="${PHOTO_FTP_PASSWORD:-}"
passive_host="${PHOTO_FTP_PASSIVE_HOST:-127.0.0.1}"
passive_min="${PHOTO_FTP_PASSIVE_MIN:-30000}"
passive_max="${PHOTO_FTP_PASSIVE_MAX:-30009}"
minimum_password_length="${PHOTO_FTP_MIN_PASSWORD_LENGTH:-5}"
max_sessions="${PHOTO_FTP_MAX_SESSIONS:-10}"
max_sessions_per_ip="${PHOTO_FTP_MAX_SESSIONS_PER_IP:-10}"
verbose_log="${PHOTO_FTP_VERBOSE_LOG:-false}"

if [ "${#password}" -lt "$minimum_password_length" ]; then
  echo "[photo-ftp] PHOTO_FTP_PASSWORD must contain at least ${minimum_password_length} characters." >&2
  exit 1
fi

mkdir -p /data/inbox /data/staging
if ! id "$username" >/dev/null 2>&1; then
  addgroup -S frameftp
  adduser -D -H -h /data/inbox -s /bin/sh -G frameftp -u 1001 "$username"
fi
chown -R "$username":frameftp /data/inbox
echo "$username:$password" | chpasswd

echo "[photo-ftp] starting ftp control_port=${PHOTO_FTP_PORT:-2121} passive_host=${passive_host} passive_range=${passive_min}-${passive_max} max_sessions=${max_sessions} max_sessions_per_ip=${max_sessions_per_ip}"
syslogd -O - -n &

set -- \
  -B \
  -S "0.0.0.0,${PHOTO_FTP_PORT:-2121}" \
  -P "$passive_host" \
  -p "${passive_min}:${passive_max}" \
  -l unix \
  -E \
  -j \
  -R \
  -c "$max_sessions" \
  -C "$max_sessions_per_ip"

if [ "$verbose_log" = "true" ]; then
  echo "[photo-ftp] verbose FTP command logging is enabled. Disable PHOTO_FTP_VERBOSE_LOG after diagnostics."
  set -- -d "$@"
fi

pure-ftpd "$@"

exec node dist/index.js
