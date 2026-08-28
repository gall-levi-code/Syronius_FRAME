#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$ROOT_DIR/installer/stack.sh.next" ]; then
  if ! sh -n "$ROOT_DIR/installer/stack.sh.next"; then
    echo "Downloaded FRAME installer wrapper failed syntax validation; keeping the current wrapper." >&2
    rm -f "$ROOT_DIR/installer/stack.sh.next"
    exit 1
  fi
  mv -f "$ROOT_DIR/installer/stack.sh.next" "$ROOT_DIR/installer/stack.sh"
fi
exec sh "$ROOT_DIR/installer/stack.sh" "$@"
