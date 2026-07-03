# FRAME Belabox Manager

Belabox integration scaffold for FRAME.

The operator page stays at `/belabox` behind FRAME login. Runtime device traffic uses authenticated MQTT over WebSockets at `/mqtt`, so roaming Belabox devices only need outbound HTTPS/WSS access back to FRAME.

Normal setup is Pair / Repair: enter the Belabox SSH host, username, and either a password or private key. FRAME validates SSH, provisions device credentials internally, writes the agent config, installs/repairs the boot service, and waits for the MQTT heartbeat with live UI progress. MQTT credentials and signing keys are not shown in the UI. Removing a device deletes FRAME-side credentials, ACLs, retained broker status, and cached dashboard state; it does not uninstall the remote agent.

Internally, provisioning generates a unique MQTT username/password per device and writes Mosquitto ACLs so each device can only use `frame/belabox/{device_id}/...`. FRAME signs command requests with Ed25519; the agent verifies signatures, expiry, nonce, device ID, and the allowlist before running any action.

Allowed commands are `agent_update`, `agent_restart`, `agent_status`, `log_bundle_collect`, `log_bundle_upload_stub`, and `telemetry_refresh`. SSH checks only run when both `BELABOX_SSH_ENABLED=true` and `BELABOX_AGENT_COMMANDS_ENABLED=true`; install, update, and remove actions remain disabled placeholders. The sample agent lives in `agent/belabox-agent.mjs` and reads `BELABOX_MQTT_URL`, `BELABOX_MQTT_USERNAME`, `BELABOX_MQTT_PASSWORD`, `BELABOX_DEVICE_ID`, and `BELABOX_COMMAND_SIGNING_PUBLIC_KEY_B64`.
