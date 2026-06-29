#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUNTIME_IMAGE="node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920"
ADVANCED_SETTINGS="TIMEZONE
FRAME_AUTH_SESSION_DAYS
PORTAL_PORT
AUDIO_BRIDGE_PORT
AUDIO_MONITOR_PORT
STREAMS_PORT
OVERLAYS_PORT
PHOTO_UPLOAD_PORT
PHOTO_FTP_PORT
GALLERY_PORT
TODAY_PORT
PHOTO_FTP_PASSIVE_MIN
PHOTO_FTP_PASSIVE_MAX
PHOTO_FTP_PASSIVE_HOST
PHOTO_FTP_USERNAME
PHOTO_FTP_MIN_PASSWORD_LENGTH
PHOTO_FTP_MAX_SESSIONS
PHOTO_FTP_MAX_SESSIONS_PER_IP
PHOTO_FTP_VERBOSE_LOG
PHOTO_FTP_STABLE_MS
PHOTO_FTP_SCAN_MS
PHOTO_UPLOAD_MAX_FILES
PHOTO_UPLOAD_MAX_SESSIONS
PIPELINE_POLL_MS
PIPELINE_CONCURRENCY
PHOTO_MAX_INPUT_MB
PHOTO_MAX_MEGAPIXELS
PHOTO_CONVERSION_ATTEMPTS
PHOTO_ARCHIVE_ORIGINALS
GALLERY_THUMB_WIDTH
GALLERY_THUMB_QUALITY
TODAY_DEFAULT_INTERVAL_MS
TODAY_REFRESH_MS
ENABLE_CONTAINER_RESTARTS
STATUS_REFRESH_MS
STATUS_CACHE_MS
REQUEST_TIMEOUT_MS
DISK_WARN_PERCENT
DISK_ERROR_PERCENT
DISK_MINIMUM_FREE_GB
DEFAULT_AUDIO_DELAY_MS
MAX_AUDIO_DELAY_MS
SESSION_IDLE_TIMEOUT_MINUTES
PUBLIC_RELAY_HOST
SRTLA_PORT
SRT_PLAYER_PORT
SRT_SENDER_PORT
SLS_STATS_PORT"
if [ "$#" -gt 0 ]; then
  COMMAND=$1
elif [ -t 0 ]; then
  COMMAND=menu
else
  COMMAND=help
fi
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
  data_root=$(runtime_data_root "$@")
  if is_absolute_path "$data_root"; then
    mkdir -p "$data_root"
    docker run --rm -i \
      --user "$(id -u):$(id -g)" \
      --mount "type=bind,source=$ROOT_DIR,target=/workspace" \
      --mount "type=bind,source=$data_root,target=/frame-data" \
      --env FRAME_INSTALLER_DATA_ROOT=/frame-data \
      -w /workspace \
      "$RUNTIME_IMAGE" node installer/frame-installer.mjs "$@"
  else
    docker run --rm -i \
      --user "$(id -u):$(id -g)" \
      --mount "type=bind,source=$ROOT_DIR,target=/workspace" \
      -w /workspace \
      "$RUNTIME_IMAGE" node installer/frame-installer.mjs "$@"
  fi
}

verify() {
  docker run --rm -i \
    --user "$(id -u):$(id -g)" \
    --mount "type=bind,source=$ROOT_DIR,target=/workspace" \
    -w /workspace \
    "$RUNTIME_IMAGE" node scripts/verify.mjs
}

compose() {
  if [ ! -f "$ROOT_DIR/docker-compose.yml" ]; then
    echo "The generated docker-compose.yml is missing. Run ./stack.sh install first." >&2
    exit 1
  fi
  docker compose --project-directory "$ROOT_DIR" --env-file "$ROOT_DIR/.env" \
    -f "$ROOT_DIR/docker-compose.yml" "$@"
}

read_default() {
  prompt=$1
  default=$2
  if [ -n "$default" ]; then
    printf "%s [%s]: " "$prompt" "$default"
  else
    printf "%s: " "$prompt"
  fi
  read -r REPLY
  [ -n "$REPLY" ] || REPLY=$default
}

lan_ipv4_candidates() {
  if command -v ip >/dev/null 2>&1; then
    ip -o -4 addr show scope global up 2>/dev/null |
      awk '{ split($4, address, "/"); print address[1] }' |
      grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' || true
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null |
      awk '/inet / { print $2 }' |
      grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' || true
  fi
}

photo_ftp_passive_host_default() {
  current=$(env_value PHOTO_FTP_PASSIVE_HOST 127.0.0.1)
  if [ -n "$current" ] && [ "$current" != "127.0.0.1" ]; then
    printf "%s" "$current"
    return
  fi
  candidate=$(lan_ipv4_candidates | awk 'NR == 1 { print; exit }')
  if [ -n "$candidate" ]; then
    printf "%s" "$candidate"
    return
  fi
  printf "%s" "$current"
}

read_photo_ftp_passive_host() {
  default=$(photo_ftp_passive_host_default)
  detected=$(lan_ipv4_candidates | awk '!seen[$0]++' | paste -sd ', ' -)
  if [ -n "$detected" ]; then
    echo "Detected LAN IPv4 candidates for Photo FTP: $detected"
  elif [ -z "$default" ] || [ "$default" = "127.0.0.1" ]; then
    echo "Could not auto-detect a LAN IPv4 address. Enter the FRAME host address your camera can reach."
  fi
  read_default "Photo FTP passive/LAN host" "$default"
}

configure_auth_session_days() {
  read_default "Shared login session length in days (1-30)" "$(env_value FRAME_AUTH_SESSION_DAYS 7)"
  run_install --set "FRAME_AUTH_SESSION_DAYS=$REPLY"
}

ensure_portal_auth() {
  if [ -n "$(env_value PORTAL_USERNAME "")" ] && [ -n "$(env_value PORTAL_PASSWORD "")" ]; then
    return
  fi
  echo "Portal login is required before FRAME can start."
  read_default "Portal username" "$(env_value PORTAL_USERNAME "")"
  username=$REPLY
  read_secret "Portal password (input hidden)"
  password=$REPLY
  configure_auth_session_days
  printf "%s\n%s\n" "$username" "$password" | runtime set-portal-auth
  unset username password
}

read_timezone() {
  current=$1
  [ -n "$current" ] || current=America/Chicago
  while true; do
    cat <<EOF
Timezone:
1) Eastern (America/New_York)
2) Central (America/Chicago)
3) Mountain (America/Denver)
4) Arizona (America/Phoenix)
5) Pacific (America/Los_Angeles)
6) Alaska (America/Anchorage)
7) Hawaii (Pacific/Honolulu)
8) Atlantic (America/Halifax)
9) Newfoundland (America/St_Johns)
C) Custom
EOF
    printf "Selection [keep %s]: " "$current"
    read -r choice
    case "$choice" in
      "") REPLY=$current; return ;;
      1) REPLY=America/New_York; return ;;
      2) REPLY=America/Chicago; return ;;
      3) REPLY=America/Denver; return ;;
      4) REPLY=America/Phoenix; return ;;
      5) REPLY=America/Los_Angeles; return ;;
      6) REPLY=America/Anchorage; return ;;
      7) REPLY=Pacific/Honolulu; return ;;
      8) REPLY=America/Halifax; return ;;
      9) REPLY=America/St_Johns; return ;;
      c|C) read_default "Custom timezone" "$current"; return ;;
      *) echo "Choose a listed timezone, C for custom, or Enter to keep the current value." ;;
    esac
  done
}

read_secret() {
  printf "%s: " "$1"
  stty -echo
  read -r REPLY
  stty echo
  printf "\n"
}

yes_no() {
  printf "%s [y/N]: " "$1"
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || [ "$answer" = "yes" ] || [ "$answer" = "YES" ]
}

pause_menu() {
  printf "Press Enter to return to the menu: "
  read -r _
}

env_value() {
  key=$1
  default=$2
  if [ -f "$ROOT_DIR/.env" ]; then
    value=$(sed -n "s/^${key}=//p" "$ROOT_DIR/.env" | tail -n 1)
    value=${value#\"}
    value=${value%\"}
    [ -n "$value" ] && {
      printf "%s" "$value"
      return
    }
  fi
  printf "%s" "$default"
}

argument_value() {
  wanted=$1
  shift
  previous=
  for argument in "$@"; do
    if [ "$previous" = "$wanted" ]; then
      printf "%s" "$argument"
      return
    fi
    previous=$argument
  done
}

is_absolute_path() {
  case "$1" in
    /*|?:/*) return 0 ;;
    *) return 1 ;;
  esac
}

host_data_path() {
  data_root=$1
  if is_absolute_path "$data_root"; then
    printf "%s" "$data_root"
  else
    printf "%s/%s" "$ROOT_DIR" "${data_root#./}"
  fi
}

runtime_data_root() {
  data_root=$(argument_value --data-root "$@")
  [ -n "$data_root" ] || data_root=$(env_value FRAME_DATA_ROOT ./data)
  printf "%s" "$data_root"
}

profile_enabled() {
  profiles=$(env_value COMPOSE_PROFILES "")
  case ",$profiles," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

run_install() {
  runtime install "$@"
  compose config --quiet
}

start_stack() {
  echo "Validating startup requirements..."
  runtime validate --for-start
  compose up -d --build --remove-orphans --wait --wait-timeout 120
  echo "FRAME stack reconciliation completed."
}

readiness_flow() {
  echo ""
  echo "Validation"
  runtime validate
  compose config --quiet
  echo ""
  echo "Verification"
  verify
  compose config --quiet
  echo "Configuration and contracts are ready."
  if yes_no "Start or update the complete FRAME stack now?"; then
    start_stack
  fi
}

configure_services() {
  echo ""
  echo "Configure services"
  echo "Choose Keep, Enable, or Disable for each capability."
  echo "Dependencies are enabled or disabled automatically by the installer."
  configure_capability "frame-video-relay" "Video Relay and Stream Management"
  configure_capability "frame-overlays" "Overlay Wizard"
  configure_capability "frame-audio-relay" "Audio Monitor"
  configure_capability "frame-discord-audio-bridge" "Discord Audio Bridge"
  configure_capability "frame-photo-ftp" "Photo FTP Ingest"
  configure_capability "frame-photo-webupload" "Browser Photo Upload"
  configure_capability "frame-photo-gallery" "Photo Gallery"
  configure_capability "frame-photo-todaytools" "Photo Stage"
}

configure_capability() {
  capability=$1
  label=$2
  printf "%s: 0) Keep  1) Enable  2) Disable: " "$label"
  read -r choice
  case "$choice" in
    1) run_install --enable "$capability" ;;
    2) run_install --disable "$capability" ;;
  esac
}

configure_network_storage() {
  current_mode=$(env_value FRAME_MODE LAN)
  printf "Deployment mode: 0) Keep %s  1) LAN  2) HYBRID: " "$current_mode"
  read -r mode_choice
  case "$mode_choice" in
    1) mode=LAN ;;
    2) mode=HYBRID ;;
    *) mode=$current_mode ;;
  esac
  hostname=
  if [ "$mode" = "HYBRID" ]; then
    read_default "Cloudflare public hostname" "$(env_value CLOUDFLARE_PUBLIC_HOSTNAME "")"
    hostname=$REPLY
  fi

  read_default "FRAME Edge HTTP port" "$(env_value EDGE_HTTP_PORT 80)"
  edge_port=$REPLY
  read_default "FRAME data folder" "$(env_value FRAME_DATA_ROOT "$ROOT_DIR/data")"
  data_root=$REPLY
  read_timezone "$(env_value TIMEZONE America/Chicago)"
  timezone=$REPLY
  if [ "$mode" = "HYBRID" ]; then
    run_install --mode HYBRID --public-hostname "$hostname" --edge-http-port "$edge_port" --data-root "$data_root" --set "TIMEZONE=$timezone"
  else
    run_install --mode LAN --edge-http-port "$edge_port" --data-root "$data_root" --set "TIMEZONE=$timezone"
  fi
}

configure_standard() {
  configure_network_storage
  configure_services
  ensure_portal_auth
  if profile_enabled photo-ftp; then
    read_photo_ftp_passive_host
    run_install --set "PHOTO_FTP_PASSIVE_HOST=$REPLY"
  fi
}

show_setup_issues() {
  ISSUE_COUNT=0
  if [ ! -f "$ROOT_DIR/.env" ]; then
    echo "- FRAME has not been configured yet."
    ISSUE_COUNT=$((ISSUE_COUNT + 1))
    return
  fi
  if profile_enabled photo-ftp && [ "$(env_value PHOTO_FTP_PASSIVE_HOST 127.0.0.1)" = "127.0.0.1" ]; then
    echo "- Photo FTP passive host still points at 127.0.0.1."
    ISSUE_COUNT=$((ISSUE_COUNT + 1))
  fi
  if { profile_enabled photo-ftp || profile_enabled photo-webupload; } && [ "$(env_value FRAME_HOST_DATA_ROOT /data)" = "/data" ]; then
    echo "- Host-visible photo data path is not configured for StreamerBot."
    ISSUE_COUNT=$((ISSUE_COUNT + 1))
  fi
  if [ -z "$(env_value PORTAL_USERNAME "")" ] || [ -z "$(env_value PORTAL_PASSWORD "")" ]; then
    echo "- Portal login needs setup."
    ISSUE_COUNT=$((ISSUE_COUNT + 1))
  fi
  if [ "$(env_value FRAME_MODE LAN)" = "HYBRID" ]; then
    if [ -z "$(env_value CLOUDFLARE_PUBLIC_HOSTNAME "")" ]; then
      echo "- Hybrid mode needs a public hostname."
      ISSUE_COUNT=$((ISSUE_COUNT + 1))
    fi
    data_root=$(env_value FRAME_DATA_ROOT ./data)
    token_file="$(host_data_path "$data_root")/state/cloudflare-tunnel-token"
    token=""
    [ ! -f "$token_file" ] || token=$(cat "$token_file")
    if [ "${#token}" -lt 100 ] || [ "$token" = "paste_cloudflare_tunnel_token_here" ]; then
      echo "- Hybrid mode needs a Cloudflare tunnel token."
      ISSUE_COUNT=$((ISSUE_COUNT + 1))
    fi
  fi
  if profile_enabled discord-audio-bridge; then
    discord_token=$(env_value DISCORD_TOKEN your_bot_token_here)
    discord_client_id=$(env_value DISCORD_CLIENT_ID your_discord_application_client_id_here)
    case "$discord_token:$discord_client_id" in
      your_*|*:your_*)
        echo "- Discord Audio Bridge credentials need setup."
        ISSUE_COUNT=$((ISSUE_COUNT + 1))
        ;;
    esac
  fi
}

resolve_setup_issues() {
  if [ ! -f "$ROOT_DIR/.env" ]; then
    configure_standard
    return
  fi
  if profile_enabled photo-ftp && [ "$(env_value PHOTO_FTP_PASSIVE_HOST 127.0.0.1)" = "127.0.0.1" ]; then
    read_photo_ftp_passive_host
    run_install --set "PHOTO_FTP_PASSIVE_HOST=$REPLY"
  fi
  if { profile_enabled photo-ftp || profile_enabled photo-webupload; } && [ "$(env_value FRAME_HOST_DATA_ROOT /data)" = "/data" ]; then
    run_install --host-data-root "$(host_data_path "$(env_value FRAME_DATA_ROOT ./data)")"
  fi
  if [ -z "$(env_value PORTAL_USERNAME "")" ] || [ -z "$(env_value PORTAL_PASSWORD "")" ]; then
    ensure_portal_auth
  fi
  if [ "$(env_value FRAME_MODE LAN)" = "HYBRID" ] && yes_no "Review Hybrid credentials now?"; then
    configure_credentials
  fi
}

advanced_setting() {
  echo ""
  echo "Advanced non-secret settings"
  printf "%s\n" "$ADVANCED_SETTINGS" | awk '{ printf "%d. %s\n", NR, $0 }'
  echo "0. Back"
  printf "Setting to change: "
  read -r choice
  [ "$choice" != "0" ] || return
  case "$choice" in *[!0-9]*|"") echo "Invalid selection."; return ;; esac
  key=$(printf "%s\n" "$ADVANCED_SETTINGS" | sed -n "${choice}p")
  [ -n "$key" ] || { echo "Invalid selection."; return; }
  read_default "New value" "$(env_value "$key" "")"
  run_install --set "$key=$REPLY"
}

configure_credentials() {
  while :; do
    echo ""
    echo "Credentials and security"
    echo "1. Portal login and session length"
    echo "2. Cloudflare tunnel token"
    echo "3. Discord bot credentials"
    echo "4. Photo FTP credentials"
    echo "5. Stream Management basic auth"
    echo "6. Overlay Wizard basic auth"
    echo "0. Back"
    printf "Selection: "
    read -r choice
    case "$choice" in
      0) return ;;
      1)
        read_default "Portal username" "$(env_value PORTAL_USERNAME "")"
        username=$REPLY
        read_secret "Portal password (input hidden)"
        password=$REPLY
        configure_auth_session_days
        printf "%s\n%s\n" "$username" "$password" | runtime set-portal-auth
        unset password
        ;;
      2)
        read_secret "Cloudflare tunnel token (input hidden)"
        token=$REPLY
        printf "%s\n" "$token" | runtime set-tunnel-token
        unset token
        ;;
      3)
        read_default "Discord application client ID" "$(env_value DISCORD_CLIENT_ID "")"
        client_id=$REPLY
        read_secret "Discord bot token (input hidden)"
        token=$REPLY
        printf "%s\n%s\n" "$client_id" "$token" | runtime set-discord-auth
        unset token
        ;;
      4)
        read_default "Photo FTP username" "$(env_value PHOTO_FTP_USERNAME frame)"
        username=$REPLY
        minimum=$(env_value PHOTO_FTP_MIN_PASSWORD_LENGTH 5)
        read_secret "Photo FTP password, at least ${minimum} characters (input hidden)"
        password=$REPLY
        printf "photo-ftp\n%s\n%s\n" "$username" "$password" | runtime set-service-auth
        unset password
        ;;
      5)
        read_default "Stream Management username" "$(env_value STREAMS_USERNAME "")"
        username=$REPLY
        read_secret "Stream Management password (input hidden)"
        password=$REPLY
        printf "streams\n%s\n%s\n" "$username" "$password" | runtime set-service-auth
        unset password
        ;;
      6)
        read_default "Overlay Wizard username" "$(env_value OVERLAYS_USERNAME "")"
        username=$REPLY
        read_secret "Overlay Wizard password (input hidden)"
        password=$REPLY
        printf "overlays\n%s\n%s\n" "$username" "$password" | runtime set-service-auth
        unset password
        ;;
    esac
  done
}

guided_setup() {
  echo ""
  echo "Guided FRAME setup"
  show_setup_issues
  if [ "$ISSUE_COUNT" -gt 0 ]; then
    echo ""
    echo "1. Resolve these issues only"
    echo "2. Review everything"
    echo "0. Cancel"
    printf "Selection: "
    read -r scope
    case "$scope" in
      0) return ;;
      1) resolve_setup_issues; readiness_flow; return ;;
    esac
  fi
  echo "1. Standard configuration"
  echo "2. Advanced configuration"
  echo "0. Cancel"
  printf "Selection: "
  read -r level
  [ "$level" != "0" ] || return
  configure_standard
  if [ "$level" = "2" ]; then
    while yes_no "Change an advanced setting?"; do advanced_setting; done
  fi
  if yes_no "Review optional credentials and security now?"; then configure_credentials; fi
  readiness_flow
}

interactive_menu() {
  while :; do
    printf "\033c"
    echo "Syronius FRAME Installer"
    echo "Guided configuration and lifecycle management"
    echo ""
    if [ -f "$ROOT_DIR/.env" ]; then
      echo "Current mode: $(env_value FRAME_MODE LAN)"
      echo "Timezone: $(env_value TIMEZONE America/Chicago)"
    else
      echo "Current state: Not configured"
    fi
    echo ""
    echo "1. Guided setup"
    echo "2. Configure services"
    echo "3. Configure network, storage, and timezone"
    echo "4. Configure Hybrid access"
    echo "5. Credentials and security"
    echo "6. Validate and verify"
    echo "7. Start or update stack"
    echo "8. Status and logs"
    echo "9. Stop stack"
    echo "10. Advanced settings"
    echo "11. Reset FRAME"
    echo "0. Exit"
    printf "Selection: "
    read -r choice
    case "$choice" in
      0) return ;;
      1) guided_setup; pause_menu ;;
      2) configure_services; readiness_flow; pause_menu ;;
      3) configure_network_storage; readiness_flow; pause_menu ;;
      4)
        read_default "Cloudflare public hostname" "$(env_value CLOUDFLARE_PUBLIC_HOSTNAME "")"
        run_install --mode HYBRID --public-hostname "$REPLY"
        configure_credentials
        readiness_flow
        pause_menu
        ;;
      5) configure_credentials; pause_menu ;;
      6) readiness_flow; pause_menu ;;
      7) start_stack; pause_menu ;;
      8)
        runtime status
        compose ps --all
        if yes_no "Show recent logs?"; then
          read_default "Service name, or leave blank for all" ""
          if [ -n "$REPLY" ]; then compose logs --tail 150 "$REPLY"; else compose logs --tail 150; fi
        fi
        pause_menu
        ;;
      9) if yes_no "Stop the complete FRAME stack?"; then compose down; fi; pause_menu ;;
      10) advanced_setting; readiness_flow; pause_menu ;;
      11)
        printf "Reset removes FRAME's generated config and data. Type RESET to continue: "
        read -r answer
        if [ "$answer" = "RESET" ]; then
          [ ! -f "$ROOT_DIR/docker-compose.yml" ] || compose down --remove-orphans
          runtime reset --yes
        fi
        pause_menu
        ;;
    esac
  done
}

assert_docker

case "$COMMAND" in
  menu)
    interactive_menu
    ;;
  hybrid-stage)
    printf "Cloudflare public hostname (for example frame.syroni.us): "
    read -r hostname
    [ -n "$hostname" ] || {
      echo "A Cloudflare public hostname is required." >&2
      exit 1
    }
    runtime install --mode HYBRID --public-hostname "$hostname" "$@"
    compose config --quiet
    echo "Hybrid configuration staged. No tunnel was started."
    ;;
  tunnel-token)
    printf "Paste the Cloudflare tunnel token (input hidden): "
    stty -echo
    read -r token
    stty echo
    printf "\n"
    printf "%s\n" "$token" | runtime set-tunnel-token
    unset token
    ;;
  portal-auth)
    printf "Portal username: "
    read -r username
    printf "Portal password (input hidden): "
    stty -echo
    read -r password
    stty echo
    printf "\n"
    configure_auth_session_days
    printf "%s\n%s\n" "$username" "$password" | runtime set-portal-auth
    unset username password
    ;;
  discord-auth)
    printf "Discord application client ID: "
    read -r client_id
    read_secret "Discord bot token (input hidden)"
    token=$REPLY
    printf "%s\n%s\n" "$client_id" "$token" | runtime set-discord-auth
    unset token
    ;;
  install)
    runtime install "$@"
    compose config --quiet
    ;;
  validate)
    runtime validate "$@"
    compose config --quiet
    echo "Docker Compose configuration is valid."
    ;;
  verify)
    verify
    [ ! -f "$ROOT_DIR/docker-compose.yml" ] || compose config --quiet
    echo "FRAME contracts, scripts, and Docker Compose configuration are valid."
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
