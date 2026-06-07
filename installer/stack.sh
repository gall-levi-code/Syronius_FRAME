#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUNTIME_IMAGE="node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920"
COMMAND=${1:-help}
if [ "$#" -gt 0 ]; then
  shift
fi

assert_docker() {
  command -v docker >/dev/null 2>&1 || {
    echo "Docker is required but was not found in PATH." >&2
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    echo "Docker is installed but the Docker engine is not available." >&2
    exit 1
  }
  docker compose version >/dev/null 2>&1 || {
    echo "Docker Compose v2 is required." >&2
    exit 1
  }
}

runtime() {
  docker run --rm -i \
    --user "$(id -u):$(id -g)" \
    --mount "type=bind,source=$ROOT_DIR,target=/workspace" \
    -w /workspace \
    "$RUNTIME_IMAGE" node installer/frame-installer.mjs "$@"
}

compose() {
  if [ ! -f "$ROOT_DIR/docker-compose.yml" ]; then
    echo "The generated docker-compose.yml is missing. Run ./stack.sh install first." >&2
    exit 1
  fi
  docker compose --project-directory "$ROOT_DIR" --env-file "$ROOT_DIR/.env" \
    -f "$ROOT_DIR/docker-compose.yml" "$@"
}

assert_docker

case "$COMMAND" in
  install)
    runtime install "$@"
    compose config --quiet
    ;;
  validate)
    runtime validate "$@"
    compose config --quiet
    echo "Docker Compose configuration is valid."
    ;;
  start)
    runtime validate --for-start
    compose up -d --build --remove-orphans --wait --wait-timeout 120
    ;;
  stop)
    compose down
    ;;
  status)
    runtime status
    compose ps --all
    ;;
  logs)
    compose logs --tail 150 "$@"
    ;;
  reset)
    confirmed=false
    for argument in "$@"; do
      [ "$argument" = "--yes" ] && confirmed=true
    done
    if [ "$confirmed" != "true" ]; then
      printf "Reset removes FRAME's generated config and data. Type RESET to continue: "
      read -r answer
      [ "$answer" = "RESET" ] || {
        echo "Reset cancelled."
        exit 1
      }
    fi
    [ ! -f "$ROOT_DIR/docker-compose.yml" ] || compose down --remove-orphans
    runtime reset --yes
    ;;
  *)
    runtime "$COMMAND" "$@"
    ;;
esac
