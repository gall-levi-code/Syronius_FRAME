use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    net::{TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const TUNNEL_TOKEN_PLACEHOLDER: &str = "paste_cloudflare_tunnel_token_here";
const CAPABILITY_KEYS: &[&str] = &[
    "frame-video-relay",
    "frame-audio-relay",
    "frame-discord-audio-bridge",
    "frame-photo-gallery",
    "frame-photo-ftp",
    "frame-photo-webupload",
    "frame-photo-discord",
    "frame-photo-todaytools",
    "frame-overlays",
];
const IMPLEMENTED_CAPABILITIES: &[&str] = &[
    "frame-video-relay",
    "frame-audio-relay",
    "frame-discord-audio-bridge",
    "frame-photo-gallery",
    "frame-photo-ftp",
    "frame-photo-webupload",
    "frame-photo-todaytools",
    "frame-overlays",
];
const PROFILE_ORDER: &[&str] = &[
    "audio-bridge",
    "audio-monitor",
    "video-relay",
    "overlays",
    "photo-pipeline",
    "photo-ftp",
    "photo-webupload",
    "photo-gallery",
    "photo-discord",
    "photo-today",
    "hybrid",
];
const DATA_DIRECTORIES: &[&str] = &[
    "state",
    "audio-bridge",
    "audio-monitor",
    "video-relay",
    "overlays",
    "logs",
    "inbox",
    "staging",
    "processing",
    "galleries",
    "gallery-cache",
    "archive",
    "quarantine",
    "streams",
    "today",
];
const MAX_TRACKED_INSTALLATIONS: usize = 20;
const PUBLIC_PREFIXES: &[(&str, Option<&str>)] = &[
    ("/auth", None),
    ("/dashboard", None),
    ("/status", None),
    ("/assets", None),
    ("/api/portal", None),
    ("/overlays/view", Some("frame-overlays")),
    ("/overlays/assets", Some("frame-overlays")),
    ("/photos", Some("frame-photo-webupload")),
    ("/today", Some("frame-photo-todaytools")),
    ("/gallery", Some("frame-photo-gallery")),
    ("/audio/listen", Some("frame-audio-relay")),
    ("/audio/hls", Some("frame-audio-relay")),
    ("/audio/assets", Some("frame-audio-relay")),
    ("/audio/public", Some("frame-audio-relay")),
    ("/bridge", Some("frame-discord-audio-bridge")),
];
const FORBIDDEN_PUBLIC_PREFIXES: &[&str] = &[
    "/audio/admin",
    "/audio/capture",
    "/overlays/setup",
    "/overlays/api",
    "/slsui",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStatus {
    checks: Vec<ReadinessCheck>,
    detected_installations: Vec<DetectedInstallation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreflightResult {
    checks: Vec<ReadinessCheck>,
    detected_installations: Vec<DetectedInstallation>,
}

#[derive(Debug, Serialize)]
struct SaveResult {
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyResult {
    path: String,
    setup_url: String,
    logs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
struct InstallLog {
    message: String,
}

#[derive(Debug, Serialize)]
struct ReadinessCheck {
    label: String,
    status: CheckStatus,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum CheckStatus {
    Good,
    Warn,
    Bad,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectedInstallation {
    source: String,
    detail: String,
    install_root: Option<String>,
    setup_mode: Option<String>,
    updated_at: Option<String>,
    compose_project: Option<String>,
    setup_url: Option<String>,
    plan_path: Option<String>,
    can_reconfigure: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallPlan {
    mode: String,
    deployment_mode: String,
    public_hostname: String,
    install_root: String,
    subfolders: BTreeMap<String, String>,
    selected_services: Vec<String>,
    ports: PortPlan,
    auto_ports: bool,
    #[serde(default)]
    advanced_settings: BTreeMap<String, String>,
    created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortPlan {
    edge: u16,
    photo_ftp: u16,
    photo_ftp_passive: String,
    srtla: u16,
    srt_player: u16,
    srt_sender: u16,
}

#[tauri::command]
fn detect_host() -> HostStatus {
    HostStatus {
        checks: host_checks(),
        detected_installations: detect_previous_installations(),
    }
}

#[tauri::command]
fn run_preflight(request: InstallPlan) -> PreflightResult {
    let mut checks = host_checks();
    checks.extend(storage_checks(&request));
    checks.extend(port_checks(&request));
    checks.push(ReadinessCheck {
        label: "FRAME web handoff".to_string(),
        status: CheckStatus::Warn,
        detail: setup_url(&request),
    });

    PreflightResult {
        checks,
        detected_installations: detect_previous_installations(),
    }
}

#[tauri::command]
fn save_install_plan(plan: InstallPlan) -> Result<SaveResult, String> {
    save_install_plan_inner(&plan)
}

#[tauri::command]
fn load_install_plan(install_root: String) -> Result<InstallPlan, String> {
    read_install_plan_at_root(&PathBuf::from(install_root.trim()))
}

#[tauri::command]
fn apply_install_plan(app: AppHandle, plan: InstallPlan) -> Result<ApplyResult, String> {
    let mut logs = Vec::new();
    let saved = save_install_plan_inner(&plan)?;
    let data_root = storage_root(&plan)?;
    let stack_workspace = data_root.clone();
    let stack_source = find_stack_source(&app)?;
    push_install_log(
        &app,
        &mut logs,
        format!(
            "Preparing stack workspace at {}.",
            stack_workspace.display()
        ),
    );
    prepare_stack_workspace(&app, &stack_source, &stack_workspace, &mut logs)?;
    let mode = normalize_mode(&plan.deployment_mode)?;
    let mut capabilities = capabilities_from_plan(&plan)?;
    let dependency_warnings = enforce_apply_dependencies(&mut capabilities);
    let profiles = compute_profiles(&capabilities, &mode);
    let existing_env = load_env_file(&stack_workspace.join(".env"))?;
    let env = build_apply_environment(&plan, &mode, &capabilities, &profiles, &existing_env)?;
    let config = stack_config(&mode, &capabilities);
    let effective_prefixes = compute_effective_public_prefixes(&mode, &capabilities);

    push_install_log(&app, &mut logs, "Creating FRAME data folders.");
    ensure_apply_data_directories(&data_root)?;
    write_json_file(&data_root.join("state").join("stack-config.json"), &config)?;
    write_json_file(
        &data_root
            .join("state")
            .join("effective-public-prefixes.json"),
        &serde_json::json!({
            "mode": mode,
            "prefixes": effective_prefixes,
            "generated_at": plan.created_at
        }),
    )?;
    fs::write(
        data_root.join("state").join("cloudflared-ingress.yml"),
        generate_cloudflared_ingress(&env, &effective_prefixes),
    )
    .map_err(|error| format!("Could not write Cloudflare ingress reference: {error}"))?;
    fs::write(
        data_root.join("state").join("public-routes.yml"),
        generate_public_routes(&effective_prefixes),
    )
    .map_err(|error| format!("Could not write public routes: {error}"))?;
    ensure_tunnel_token_file(&data_root)?;

    let compose_template = stack_workspace
        .join("installer")
        .join("templates")
        .join("docker-compose.yml");
    let compose_target = stack_workspace.join("docker-compose.yml");
    fs::copy(&compose_template, &compose_target)
        .map_err(|error| format!("Could not write docker-compose.yml from template: {error}"))?;
    fs::write(stack_workspace.join(".env"), serialize_env(&env))
        .map_err(|error| format!("Could not write .env: {error}"))?;

    push_install_log(
        &app,
        &mut logs,
        format!("FRAME configuration installed at {}.", data_root.display()),
    );
    push_install_log(
        &app,
        &mut logs,
        format!("Compose profiles: {}", profiles.join(",")),
    );
    for warning in dependency_warnings {
        push_install_log(&app, &mut logs, format!("Warning: {warning}"));
    }
    if capabilities
        .get("frame-discord-audio-bridge")
        .copied()
        .unwrap_or(false)
    {
        push_install_log(&app, &mut logs, "Discord Audio Bridge was enabled. Add Discord credentials in localhost/setup before using the bot.");
    }
    if capabilities
        .get("frame-photo-ftp")
        .copied()
        .unwrap_or(false)
    {
        push_install_log(&app, &mut logs, "Photo FTP was enabled. Set the passive host to this machine's LAN IP in localhost/setup before camera testing.");
    }
    if mode == "HYBRID" {
        push_install_log(&app, &mut logs, "Hybrid mode was enabled. Add the Cloudflare tunnel token in localhost/setup before exposing public routes.");
    }

    run_compose_config(&app, &stack_workspace, &mut logs)?;
    run_compose_up(&app, &stack_workspace, &mut logs)?;
    wait_for_web_setup(&app, &mut logs, plan.ports.edge)?;

    Ok(ApplyResult {
        path: saved.path,
        setup_url: setup_url(&plan),
        logs,
    })
}

fn push_install_log(app: &AppHandle, logs: &mut Vec<String>, message: impl Into<String>) {
    let message = message.into();
    logs.push(message.clone());
    let _ = app.emit("install-log", InstallLog { message });
}

fn prepare_stack_workspace(
    app: &AppHandle,
    source: &Path,
    workspace: &Path,
    logs: &mut Vec<String>,
) -> Result<(), String> {
    fs::create_dir_all(workspace)
        .map_err(|error| format!("Could not create install workspace: {error}"))?;
    push_install_log(
        app,
        logs,
        format!("Copying stack resources from {}.", source.display()),
    );
    copy_dir_recursive(
        &source.join("services"),
        &workspace.join("services"),
        &["node_modules", "dist", "target"],
    )?;
    copy_dir_recursive(
        &source.join("config"),
        &workspace.join("config"),
        &["node_modules", "dist", "target"],
    )?;
    let template_source = source
        .join("installer")
        .join("templates")
        .join("docker-compose.yml");
    let template_target = workspace
        .join("installer")
        .join("templates")
        .join("docker-compose.yml");
    copy_file(&template_source, &template_target)?;
    Ok(())
}

fn find_stack_source(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_stack = resource_dir.join("frame-stack");
        if bundled_stack.join("services").is_dir()
            && bundled_stack.join("config").is_dir()
            && bundled_stack
                .join("installer")
                .join("templates")
                .join("docker-compose.yml")
                .exists()
        {
            return Ok(bundled_stack);
        }
    }

    find_repo_root()
}

fn copy_dir_recursive(source: &Path, target: &Path, skipped_names: &[&str]) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!(
            "Missing bundled resource directory: {}",
            source.display()
        ));
    }
    fs::create_dir_all(target)
        .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("Could not read resource entry: {error}"))?;
        let name = entry.file_name();
        let name_lossy = name.to_string_lossy();
        if skipped_names.iter().any(|skipped| *skipped == name_lossy) {
            continue;
        }
        let source_path = entry.path();
        let target_path = target.join(name);
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Could not inspect {}: {error}", source_path.display()))?;
        if metadata.is_dir() {
            copy_dir_recursive(&source_path, &target_path, skipped_names)?;
        } else if metadata.is_file() {
            copy_file(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    fs::copy(source, target).map(|_| ()).map_err(|error| {
        format!(
            "Could not copy {} to {}: {error}",
            source.display(),
            target.display()
        )
    })
}

fn wait_for_web_setup(app: &AppHandle, logs: &mut Vec<String>, port: u16) -> Result<(), String> {
    push_install_log(
        app,
        logs,
        "Waiting for FRAME web edge to accept connections.",
    );
    let deadline = SystemTime::now() + Duration::from_secs(120);
    loop {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            push_install_log(
                app,
                logs,
                "FRAME web edge is reachable. Continue with FRAME Setup.",
            );
            return Ok(());
        }
        if SystemTime::now() >= deadline {
            return Err("FRAME web edge did not become reachable within 120 seconds. Check Docker Desktop and container logs.".to_string());
        }
        thread::sleep(Duration::from_millis(750));
    }
}

fn save_install_plan_inner(plan: &InstallPlan) -> Result<SaveResult, String> {
    let root = storage_root(plan)?;
    if root.as_os_str().is_empty() {
        return Err("Choose a FRAME storage root before saving the plan.".to_string());
    }

    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir)
        .map_err(|error| format!("Could not create state directory: {error}"))?;

    let plan_path = state_dir.join("frame-install-plan.json");
    let marker_path = state_dir.join("frame-install.json");
    let plan_json = serde_json::to_string_pretty(&plan).map_err(|error| error.to_string())?;
    fs::write(&plan_path, plan_json)
        .map_err(|error| format!("Could not write install plan: {error}"))?;

    let marker = serde_json::json!({
        "product": "Syronius FRAME",
        "install_id": stable_install_id(&root),
        "storage_root": root.display().to_string(),
        "compose_project": "syronius-frame",
        "created_or_seen_at": plan.created_at,
        "setup_mode": plan.mode
    });
    fs::write(
        &marker_path,
        serde_json::to_string_pretty(&marker).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Could not write install marker: {error}"))?;
    record_installation(&root, plan)?;

    Ok(SaveResult {
        path: plan_path.display().to_string(),
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            detect_host,
            run_preflight,
            save_install_plan,
            load_install_plan,
            apply_install_plan
        ])
        .run(tauri::generate_context!())
        .expect("error while running FRAME Setup");
}

fn host_checks() -> Vec<ReadinessCheck> {
    let docker_cli = command_exists("docker", &["--version"]);
    let docker_engine = command_success("docker", &["info"], Duration::from_secs(6));
    let compose = command_success("docker", &["compose", "version"], Duration::from_secs(6));

    vec![
        ReadinessCheck {
            label: "Docker CLI".to_string(),
            status: if docker_cli {
                CheckStatus::Good
            } else {
                CheckStatus::Bad
            },
            detail: if docker_cli {
                command_output("docker", &["--version"])
                    .unwrap_or_else(|| "Docker CLI detected.".to_string())
            } else {
                "Docker was not found. Install Docker Desktop or Docker Engine, then recheck."
                    .to_string()
            },
        },
        ReadinessCheck {
            label: "Docker Engine".to_string(),
            status: if docker_engine {
                CheckStatus::Good
            } else {
                CheckStatus::Bad
            },
            detail: if docker_engine {
                "Docker Engine responded.".to_string()
            } else {
                "Docker is missing, stopped, or unavailable to this user. Start Docker, then recheck.".to_string()
            },
        },
        ReadinessCheck {
            label: "Docker Compose".to_string(),
            status: if compose {
                CheckStatus::Good
            } else {
                CheckStatus::Bad
            },
            detail: if compose {
                command_output("docker", &["compose", "version"])
                    .unwrap_or_else(|| "Docker Compose v2 detected.".to_string())
            } else {
                "Docker Compose v2 was not found.".to_string()
            },
        },
    ]
}

fn storage_checks(plan: &InstallPlan) -> Vec<ReadinessCheck> {
    let root = PathBuf::from(plan.install_root.trim());
    if root.as_os_str().is_empty() {
        return vec![ReadinessCheck {
            label: "Storage root".to_string(),
            status: CheckStatus::Bad,
            detail: "Choose one host folder for FRAME data.".to_string(),
        }];
    }

    let exists = root.exists();
    let writable = test_writable(&root);
    vec![ReadinessCheck {
        label: "Storage root".to_string(),
        status: if writable {
            CheckStatus::Good
        } else {
            CheckStatus::Warn
        },
        detail: if writable {
            format!("{} is writable.", root.display())
        } else if exists {
            format!("{} exists but did not pass the write test.", root.display())
        } else {
            format!(
                "{} does not exist yet. FRAME can create it during install.",
                root.display()
            )
        },
    }]
}

fn port_checks(plan: &InstallPlan) -> Vec<ReadinessCheck> {
    let mut checks = Vec::new();
    checks.push(check_tcp_port("FRAME web GUI", plan.ports.edge));

    if plan
        .selected_services
        .iter()
        .any(|service| service == "frame-photo-ftp")
    {
        checks.push(check_tcp_port("Photo FTP control", plan.ports.photo_ftp));
        checks.extend(check_passive_range(&plan.ports.photo_ftp_passive));
    }

    if plan
        .selected_services
        .iter()
        .any(|service| service == "frame-video-relay")
    {
        checks.push(check_udp_port("SRTLA ingest", plan.ports.srtla));
        checks.push(check_udp_port("SRT player", plan.ports.srt_player));
        checks.push(check_udp_port("SRT sender", plan.ports.srt_sender));
    }

    checks
}

fn check_tcp_port(label: &str, port: u16) -> ReadinessCheck {
    let available = TcpListener::bind(("0.0.0.0", port)).is_ok();
    ReadinessCheck {
        label: label.to_string(),
        status: if available {
            CheckStatus::Good
        } else {
            CheckStatus::Warn
        },
        detail: if available {
            format!("TCP {port} is available.")
        } else {
            format!("TCP {port} is already in use. Auto-port mode can choose another value.")
        },
    }
}

fn check_udp_port(label: &str, port: u16) -> ReadinessCheck {
    let available = UdpSocket::bind(("0.0.0.0", port)).is_ok();
    ReadinessCheck {
        label: label.to_string(),
        status: if available {
            CheckStatus::Good
        } else {
            CheckStatus::Warn
        },
        detail: if available {
            format!("UDP {port} is available.")
        } else {
            format!("UDP {port} is already in use. Auto-port mode can choose another value.")
        },
    }
}

fn check_passive_range(range: &str) -> Vec<ReadinessCheck> {
    let Some((start, end)) = parse_range(range) else {
        return vec![ReadinessCheck {
            label: "Photo FTP passive range".to_string(),
            status: CheckStatus::Bad,
            detail: "Use a range like 30000-30019.".to_string(),
        }];
    };

    let mut blocked = Vec::new();
    for port in start..=end {
        if TcpListener::bind(("0.0.0.0", port)).is_err() {
            blocked.push(port);
        }
    }

    vec![ReadinessCheck {
        label: "Photo FTP passive range".to_string(),
        status: if blocked.is_empty() {
            CheckStatus::Good
        } else {
            CheckStatus::Warn
        },
        detail: if blocked.is_empty() {
            format!("TCP {start}-{end} is available.")
        } else {
            format!("{} passive port(s) are already in use.", blocked.len())
        },
    }]
}

fn detect_previous_installations() -> Vec<DetectedInstallation> {
    let mut installs = Vec::new();

    for path in known_registry_paths() {
        if path.exists() {
            match read_registry_installations(&path) {
                Ok(registry_installs) if !registry_installs.is_empty() => {
                    for install in registry_installs {
                        installs.push(install);
                    }
                }
                _ => installs.push(DetectedInstallation {
                    source: "App registry".to_string(),
                    detail: path.display().to_string(),
                    install_root: None,
                    setup_mode: None,
                    updated_at: None,
                    compose_project: None,
                    setup_url: None,
                    plan_path: None,
                    can_reconfigure: false,
                }),
            }
        }
    }

    if let Some(output) = command_output(
        "docker",
        &[
            "ps",
            "-a",
            "--filter",
            "label=frame.owner=syronius-frame",
            "--format",
            "{{.Names}} {{.Status}}",
        ],
    ) {
        for line in output.lines().filter(|line| !line.trim().is_empty()) {
            installs.push(DetectedInstallation {
                source: "Docker labels".to_string(),
                detail: line.to_string(),
                install_root: None,
                setup_mode: None,
                updated_at: None,
                compose_project: Some("syronius-frame".to_string()),
                setup_url: None,
                plan_path: None,
                can_reconfigure: false,
            });
        }
    }

    installs
}

fn record_installation(root: &Path, plan: &InstallPlan) -> Result<(), String> {
    let Some(registry_path) = primary_registry_path() else {
        return Ok(());
    };
    if let Some(parent) = registry_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create install registry directory: {error}"))?;
    }

    let mut installs = read_registry_values(&registry_path).unwrap_or_default();
    let install_id = stable_install_id(root);
    installs.retain(|entry| {
        entry.get("install_id").and_then(serde_json::Value::as_str) != Some(install_id.as_str())
    });
    installs.push(serde_json::json!({
        "install_id": install_id,
        "storage_root": root.display().to_string(),
        "compose_project": "syronius-frame",
        "setup_mode": plan.mode,
        "updated_at": plan.created_at
    }));
    installs.sort_by(|left, right| {
        registry_updated_at(right)
            .cmp(&registry_updated_at(left))
            .then_with(|| registry_root(right).cmp(&registry_root(left)))
    });
    installs.truncate(MAX_TRACKED_INSTALLATIONS);

    fs::write(
        &registry_path,
        serde_json::to_string_pretty(&installs).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Could not write install registry: {error}"))
}

fn read_registry_installations(path: &Path) -> Result<Vec<DetectedInstallation>, String> {
    let installs = read_registry_values(path)?;
    Ok(installs
        .into_iter()
        .filter_map(|entry| {
            let root = entry.get("storage_root")?.as_str()?.to_string();
            let root_path = PathBuf::from(&root);
            let plan_path = install_plan_path(&root_path);
            let plan = read_install_plan_at_root(&root_path).ok();
            let mode = entry
                .get("setup_mode")
                .and_then(serde_json::Value::as_str)
                .or_else(|| plan.as_ref().map(|plan| plan.mode.as_str()))
                .unwrap_or("unknown");
            let updated_at = entry
                .get("updated_at")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let compose_project = entry
                .get("compose_project")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let setup_url = plan.as_ref().map(setup_url);
            let can_reconfigure = plan.is_some();
            Some(DetectedInstallation {
                source: "App registry".to_string(),
                detail: root.clone(),
                install_root: Some(root),
                setup_mode: Some(mode.to_string()),
                updated_at,
                compose_project,
                setup_url,
                plan_path: Some(plan_path.display().to_string()),
                can_reconfigure,
            })
        })
        .collect())
}

fn read_install_plan_at_root(root: &Path) -> Result<InstallPlan, String> {
    if root.as_os_str().is_empty() {
        return Err("Choose a FRAME install root.".to_string());
    }
    let path = install_plan_path(root);
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read install plan at {}: {error}", path.display()))?;
    serde_json::from_str::<InstallPlan>(&contents)
        .map_err(|error| format!("Install plan contains invalid JSON: {error}"))
}

fn install_plan_path(root: &Path) -> PathBuf {
    root.join("state").join("frame-install-plan.json")
}

fn registry_updated_at(entry: &serde_json::Value) -> String {
    entry
        .get("updated_at")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn registry_root(entry: &serde_json::Value) -> String {
    entry
        .get("storage_root")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn read_registry_values(path: &Path) -> Result<Vec<serde_json::Value>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not read install registry: {error}")),
    };
    let value = serde_json::from_str::<serde_json::Value>(&contents)
        .map_err(|error| format!("Install registry contains invalid JSON: {error}"))?;
    Ok(match value {
        serde_json::Value::Array(entries) => entries,
        serde_json::Value::Object(mut object) => object
            .remove("installations")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default(),
        _ => Vec::new(),
    })
}

fn known_registry_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        paths.push(
            PathBuf::from(appdata)
                .join("Syronius FRAME")
                .join("installations.json"),
        );
    }
    if let Ok(home) = std::env::var("HOME") {
        paths.push(
            PathBuf::from(&home)
                .join(".config")
                .join("syronius-frame")
                .join("installations.json"),
        );
        paths.push(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Syronius FRAME")
                .join("installations.json"),
        );
    }
    paths
}

fn primary_registry_path() -> Option<PathBuf> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return Some(
            PathBuf::from(appdata)
                .join("Syronius FRAME")
                .join("installations.json"),
        );
    }
    std::env::var("HOME").ok().map(|home| {
        PathBuf::from(home)
            .join(".config")
            .join("syronius-frame")
            .join("installations.json")
    })
}

fn command_exists(command: &str, args: &[&str]) -> bool {
    command_success(command, args, Duration::from_secs(3))
}

fn command_success(command: &str, args: &[&str], _timeout: Duration) -> bool {
    hidden_command(command)
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn command_output(command: &str, args: &[&str]) -> Option<String> {
    let output = hidden_command(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn hidden_command(command: &str) -> Command {
    let mut process = Command::new(command);
    #[cfg(windows)]
    process.creation_flags(CREATE_NO_WINDOW);
    process
}

fn test_writable(root: &Path) -> bool {
    if fs::create_dir_all(root).is_err() {
        return false;
    }
    let test_path = root.join(".frame-write-test");
    if fs::write(&test_path, b"ok").is_err() {
        return false;
    }
    let _ = fs::remove_file(test_path);
    true
}

fn parse_range(range: &str) -> Option<(u16, u16)> {
    let (start, end) = range.split_once('-')?;
    let start = start.trim().parse::<u16>().ok()?;
    let end = end.trim().parse::<u16>().ok()?;
    if start > end {
        return None;
    }
    Some((start, end))
}

fn stable_install_id(root: &Path) -> String {
    let input = root.display().to_string();
    let hash = input.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("frame-{hash:016x}")
}

fn storage_root(plan: &InstallPlan) -> Result<PathBuf, String> {
    let trimmed = plan.install_root.trim();
    if trimmed.is_empty() {
        return Err("Choose a FRAME storage root before continuing.".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

fn normalize_mode(value: &str) -> Result<String, String> {
    let mode = value.trim().to_uppercase();
    if mode == "LAN" || mode == "HYBRID" {
        Ok(mode)
    } else {
        Err("Deployment mode must be LAN or HYBRID.".to_string())
    }
}

fn capabilities_from_plan(plan: &InstallPlan) -> Result<BTreeMap<String, bool>, String> {
    let mut capabilities = CAPABILITY_KEYS
        .iter()
        .map(|name| ((*name).to_string(), false))
        .collect::<BTreeMap<_, _>>();

    for service in &plan.selected_services {
        let service = service.as_str();
        if !CAPABILITY_KEYS.contains(&service) {
            return Err(format!("Unknown FRAME service selected: {service}"));
        }
        if !IMPLEMENTED_CAPABILITIES.contains(&service) {
            return Err(format!(
                "{service} is not implemented yet and cannot be installed."
            ));
        }
        capabilities.insert(service.to_string(), true);
    }

    Ok(capabilities)
}

fn enforce_apply_dependencies(capabilities: &mut BTreeMap<String, bool>) -> Vec<String> {
    let mut warnings = Vec::new();
    let photo_input_enabled = capabilities
        .get("frame-photo-ftp")
        .copied()
        .unwrap_or(false)
        || capabilities
            .get("frame-photo-webupload")
            .copied()
            .unwrap_or(false);

    if capabilities.get("frame-overlays").copied().unwrap_or(false)
        && !capabilities
            .get("frame-video-relay")
            .copied()
            .unwrap_or(false)
    {
        capabilities.insert("frame-overlays".to_string(), false);
        warnings.push("Overlay Wizard was disabled because Stream Relay is disabled.".to_string());
    }

    if capabilities
        .get("frame-photo-gallery")
        .copied()
        .unwrap_or(false)
        && !photo_input_enabled
    {
        capabilities.insert("frame-photo-gallery".to_string(), false);
        warnings.push(
            "Photo Gallery was disabled because no photo input service is enabled.".to_string(),
        );
    }

    if capabilities
        .get("frame-photo-todaytools")
        .copied()
        .unwrap_or(false)
        && !capabilities
            .get("frame-photo-gallery")
            .copied()
            .unwrap_or(false)
    {
        capabilities.insert("frame-photo-todaytools".to_string(), false);
        warnings.push("Photo Stage was disabled because Photo Gallery is disabled.".to_string());
    } else if capabilities
        .get("frame-photo-todaytools")
        .copied()
        .unwrap_or(false)
        && !photo_input_enabled
    {
        capabilities.insert("frame-photo-todaytools".to_string(), false);
        warnings.push(
            "Photo Stage was disabled because no photo input service is enabled.".to_string(),
        );
    }

    warnings
}

fn compute_profiles(capabilities: &BTreeMap<String, bool>, mode: &str) -> Vec<String> {
    let mut enabled = BTreeSet::new();
    add_capability_profiles(
        capabilities,
        &mut enabled,
        "frame-discord-audio-bridge",
        &["audio-bridge"],
    );
    add_capability_profiles(
        capabilities,
        &mut enabled,
        "frame-audio-relay",
        &["audio-monitor"],
    );
    add_capability_profiles(
        capabilities,
        &mut enabled,
        "frame-video-relay",
        &["video-relay"],
    );
    add_capability_profiles(capabilities, &mut enabled, "frame-overlays", &["overlays"]);
    add_capability_profiles(
        capabilities,
        &mut enabled,
        "frame-photo-ftp",
        &["photo-pipeline", "photo-ftp"],
    );
    add_capability_profiles(
        capabilities,
        &mut enabled,
        "frame-photo-webupload",
        &["photo-pipeline", "photo-webupload"],
    );
    add_capability_profiles(
        capabilities,
        &mut enabled,
        "frame-photo-gallery",
        &["photo-pipeline", "photo-gallery"],
    );
    add_capability_profiles(
        capabilities,
        &mut enabled,
        "frame-photo-todaytools",
        &["photo-pipeline", "photo-today"],
    );
    if mode == "HYBRID" {
        enabled.insert("hybrid");
    }
    PROFILE_ORDER
        .iter()
        .filter(|profile| enabled.contains(**profile))
        .map(|profile| (*profile).to_string())
        .collect()
}

fn add_capability_profiles(
    capabilities: &BTreeMap<String, bool>,
    enabled: &mut BTreeSet<&'static str>,
    capability: &str,
    profiles: &[&'static str],
) {
    if capabilities.get(capability).copied().unwrap_or(false) {
        for profile in profiles {
            enabled.insert(*profile);
        }
    }
}

fn stack_config(mode: &str, capabilities: &BTreeMap<String, bool>) -> serde_json::Value {
    serde_json::json!({
        "mode": mode,
        "capabilities": capabilities,
        "routes": {
            "dashboard": "/dashboard",
            "status": "/status",
            "video_relay_ui": "/slsui",
            "overlays_root": "/overlays",
            "overlays_wizard": "/overlays/setup",
            "photo_upload": "/photos/upload",
            "photo_gallery": "/today/gallery",
            "today_gallery": "/today/gallery",
            "today_dashboard": "/today/dashboard",
            "today_viewer": "/today/viewer",
            "today_remote": "/today/remote",
            "audio_admin": "/audio/admin",
            "audio_capture": "/audio/capture",
            "audio_listen": "/audio/listen",
            "audio_hls": "/audio/hls",
            "discord_audio_bridge_root": "/bridge"
        },
        "public_route_prefixes": PUBLIC_PREFIXES.iter().map(|(prefix, _)| *prefix).collect::<Vec<_>>()
    })
}

fn compute_effective_public_prefixes(
    mode: &str,
    capabilities: &BTreeMap<String, bool>,
) -> Vec<String> {
    if mode != "HYBRID" {
        return Vec::new();
    }

    let mut prefixes = Vec::new();
    for (prefix, capability) in PUBLIC_PREFIXES {
        if FORBIDDEN_PUBLIC_PREFIXES
            .iter()
            .any(|forbidden| path_matches_prefix(prefix, forbidden))
        {
            continue;
        }
        if let Some(capability) = capability {
            if !capabilities.get(*capability).copied().unwrap_or(false) {
                continue;
            }
        }
        prefixes.push((*prefix).to_string());
    }
    normalize_prefixes(prefixes)
}

fn normalize_prefixes(mut prefixes: Vec<String>) -> Vec<String> {
    prefixes.sort_by(|left, right| left.len().cmp(&right.len()).then_with(|| left.cmp(right)));
    prefixes.dedup();
    let mut normalized: Vec<String> = Vec::new();
    for prefix in prefixes {
        if !normalized
            .iter()
            .any(|parent| path_matches_prefix(&prefix, parent.as_str()))
        {
            normalized.push(prefix);
        }
    }
    normalized
}

fn path_matches_prefix(value: &str, prefix: &str) -> bool {
    value == prefix || value.starts_with(&format!("{prefix}/"))
}

fn ensure_apply_data_directories(data_root: &Path) -> Result<(), String> {
    for directory in DATA_DIRECTORIES {
        fs::create_dir_all(data_root.join(directory))
            .map_err(|error| format!("Could not create {directory} data directory: {error}"))?;
    }
    Ok(())
}

fn write_json_file(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, format!("{json}\n"))
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn ensure_tunnel_token_file(data_root: &Path) -> Result<(), String> {
    let path = data_root.join("state").join("cloudflare-tunnel-token");
    if path.exists() {
        return Ok(());
    }
    fs::write(&path, format!("{TUNNEL_TOKEN_PLACEHOLDER}\n"))
        .map_err(|error| format!("Could not write Cloudflare tunnel token placeholder: {error}"))
}

fn find_repo_root() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }

    for candidate in candidates {
        for ancestor in candidate.ancestors() {
            if ancestor
                .join("installer")
                .join("templates")
                .join("docker-compose.yml")
                .exists()
                && ancestor.join("services").is_dir()
            {
                return Ok(ancestor.to_path_buf());
            }
        }
    }

    Err("Could not find the Syronius_FRAME repository root. Run the setup app from the project workspace for this development build.".to_string())
}

fn load_env_file(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(format!("Could not read existing .env: {error}")),
    };
    let mut env = BTreeMap::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        env.insert(key.trim().to_string(), parse_env_value(value.trim()));
    }
    Ok(env)
}

fn parse_env_value(value: &str) -> String {
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len() - 1].to_string())
    } else if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

fn build_apply_environment(
    plan: &InstallPlan,
    mode: &str,
    _capabilities: &BTreeMap<String, bool>,
    profiles: &[String],
    existing: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let data_root = storage_root(plan)?;
    let data_root_env = path_to_env(&data_root);
    let edge_port = validate_port(plan.ports.edge, "FRAME Edge port")?.to_string();
    let audio_bridge_port = existing_or(existing, "AUDIO_BRIDGE_PORT", "3729");
    let (photo_ftp_passive_min, photo_ftp_passive_max) = parse_range(&plan.ports.photo_ftp_passive)
        .ok_or_else(|| "Photo FTP passive range must look like 30000-30019.".to_string())?;
    let hostname = plan.public_hostname.trim().to_lowercase();
    if mode == "HYBRID" && !is_valid_public_hostname(&hostname) {
        return Err(
            "Hybrid mode requires a valid public hostname like frame.example.com.".to_string(),
        );
    }
    let photo_ftp_min_password_length = advanced_setting_or(
        plan,
        existing,
        "PHOTO_FTP_MIN_PASSWORD_LENGTH",
        "5",
        5,
        128,
        "Photo FTP minimum password length",
    )?;

    let edge_lan_base_url = format_local_http_url(plan.ports.edge);
    let edge_public_base_url = if mode == "HYBRID" {
        format!("https://{hostname}")
    } else {
        edge_lan_base_url.clone()
    };

    let mut env = BTreeMap::new();
    env.insert("FRAME_MODE".to_string(), mode.to_string());
    env.insert("FRAME_DATA_ROOT".to_string(), data_root_env.clone());
    env.insert(
        "FRAME_HOST_DATA_ROOT".to_string(),
        existing_or(existing, "FRAME_HOST_DATA_ROOT", &data_root_env),
    );
    env.insert(
        "TIMEZONE".to_string(),
        existing_or(existing, "TIMEZONE", "America/Chicago"),
    );
    env.insert("COMPOSE_PROFILES".to_string(), profiles.join(","));
    env.insert("EDGE_HTTP_PORT".to_string(), edge_port);
    env.insert(
        "EDGE_PUBLIC_BASE_URL".to_string(),
        edge_public_base_url.clone(),
    );
    env.insert("EDGE_LAN_BASE_URL".to_string(), edge_lan_base_url.clone());
    env.insert("CLOUDFLARE_PUBLIC_HOSTNAME".to_string(), hostname);
    env.insert(
        "CLOUDFLARE_TUNNEL_ORIGIN".to_string(),
        "http://frame-public-gateway:8080".to_string(),
    );
    env.insert(
        "PORTAL_PORT".to_string(),
        existing_or(existing, "PORTAL_PORT", "3730"),
    );
    env.insert("AUDIO_BRIDGE_PORT".to_string(), audio_bridge_port.clone());
    env.insert(
        "AUDIO_MONITOR_PORT".to_string(),
        existing_or(existing, "AUDIO_MONITOR_PORT", "3734"),
    );
    env.insert(
        "AUDIO_PUBLIC_BASE_URL".to_string(),
        edge_public_base_url.clone(),
    );
    env.insert(
        "AUDIO_CAPTURE_BASE_URL".to_string(),
        edge_lan_base_url.clone(),
    );
    env.insert(
        "STREAMS_PORT".to_string(),
        existing_or(existing, "STREAMS_PORT", "3732"),
    );
    env.insert(
        "OVERLAYS_PORT".to_string(),
        existing_or(existing, "OVERLAYS_PORT", "3733"),
    );
    env.insert(
        "PHOTO_UPLOAD_PORT".to_string(),
        existing_or(existing, "PHOTO_UPLOAD_PORT", "3736"),
    );
    env.insert(
        "PHOTO_FTP_PORT".to_string(),
        validate_port(plan.ports.photo_ftp, "Photo FTP port")?.to_string(),
    );
    env.insert(
        "GALLERY_PORT".to_string(),
        existing_or(existing, "GALLERY_PORT", "3738"),
    );
    env.insert(
        "TODAY_PORT".to_string(),
        existing_or(existing, "TODAY_PORT", "3739"),
    );
    env.insert(
        "PHOTO_FTP_PASSIVE_MIN".to_string(),
        photo_ftp_passive_min.to_string(),
    );
    env.insert(
        "PHOTO_FTP_PASSIVE_MAX".to_string(),
        photo_ftp_passive_max.to_string(),
    );
    env.insert(
        "PHOTO_FTP_PASSIVE_HOST".to_string(),
        existing_or(existing, "PHOTO_FTP_PASSIVE_HOST", "127.0.0.1"),
    );
    env.insert(
        "PHOTO_FTP_USERNAME".to_string(),
        existing_or(existing, "PHOTO_FTP_USERNAME", "frame"),
    );
    env.insert(
        "PHOTO_FTP_PASSWORD".to_string(),
        preserve_secret(
            existing,
            "PHOTO_FTP_PASSWORD",
            photo_ftp_min_password_length.parse::<usize>().unwrap_or(5),
        ),
    );
    env.insert(
        "PHOTO_FTP_MIN_PASSWORD_LENGTH".to_string(),
        photo_ftp_min_password_length,
    );
    env.insert(
        "PHOTO_FTP_MAX_SESSIONS".to_string(),
        advanced_setting_or(
            plan,
            existing,
            "PHOTO_FTP_MAX_SESSIONS",
            "20",
            1,
            100,
            "Photo FTP max sessions",
        )?,
    );
    env.insert(
        "PHOTO_FTP_MAX_SESSIONS_PER_IP".to_string(),
        advanced_setting_or(
            plan,
            existing,
            "PHOTO_FTP_MAX_SESSIONS_PER_IP",
            "10",
            1,
            100,
            "Photo FTP max sessions per IP",
        )?,
    );
    env.insert(
        "PHOTO_FTP_VERBOSE_LOG".to_string(),
        existing_or(existing, "PHOTO_FTP_VERBOSE_LOG", "false"),
    );
    env.insert(
        "PHOTO_FTP_STABLE_MS".to_string(),
        existing_or(existing, "PHOTO_FTP_STABLE_MS", "3000"),
    );
    env.insert(
        "PHOTO_FTP_SCAN_MS".to_string(),
        existing_or(existing, "PHOTO_FTP_SCAN_MS", "1000"),
    );
    env.insert(
        "PHOTO_UPLOAD_MAX_FILES".to_string(),
        advanced_setting_or(
            plan,
            existing,
            "PHOTO_UPLOAD_MAX_FILES",
            "100",
            1,
            100,
            "Photo upload max files",
        )?,
    );
    env.insert(
        "PHOTO_UPLOAD_MAX_SESSIONS".to_string(),
        advanced_setting_or(
            plan,
            existing,
            "PHOTO_UPLOAD_MAX_SESSIONS",
            "2",
            1,
            100,
            "Photo upload max sessions",
        )?,
    );
    env.insert(
        "PIPELINE_POLL_MS".to_string(),
        existing_or(existing, "PIPELINE_POLL_MS", "1000"),
    );
    env.insert(
        "PIPELINE_CONCURRENCY".to_string(),
        existing_or(existing, "PIPELINE_CONCURRENCY", "2"),
    );
    env.insert(
        "PHOTO_MAX_INPUT_MB".to_string(),
        existing_or(existing, "PHOTO_MAX_INPUT_MB", "50"),
    );
    env.insert(
        "PHOTO_MAX_MEGAPIXELS".to_string(),
        existing_or(existing, "PHOTO_MAX_MEGAPIXELS", "80"),
    );
    env.insert(
        "PHOTO_CONVERSION_ATTEMPTS".to_string(),
        existing_or(existing, "PHOTO_CONVERSION_ATTEMPTS", "3"),
    );
    env.insert(
        "PHOTO_ARCHIVE_ORIGINALS".to_string(),
        existing_or(existing, "PHOTO_ARCHIVE_ORIGINALS", "true"),
    );
    env.insert(
        "GALLERY_THUMB_WIDTH".to_string(),
        existing_or(existing, "GALLERY_THUMB_WIDTH", "720"),
    );
    env.insert(
        "GALLERY_THUMB_QUALITY".to_string(),
        existing_or(existing, "GALLERY_THUMB_QUALITY", "82"),
    );
    env.insert(
        "TODAY_DEFAULT_INTERVAL_MS".to_string(),
        existing_or(existing, "TODAY_DEFAULT_INTERVAL_MS", "10000"),
    );
    env.insert(
        "TODAY_REFRESH_MS".to_string(),
        existing_or(existing, "TODAY_REFRESH_MS", "1000"),
    );
    env.insert(
        "FRAME_AUTH_SESSION_SECRET".to_string(),
        preserve_secret(existing, "FRAME_AUTH_SESSION_SECRET", 32),
    );
    env.insert(
        "FRAME_AUTH_SESSION_DAYS".to_string(),
        existing_or(existing, "FRAME_AUTH_SESSION_DAYS", "7"),
    );
    env.insert(
        "PORTAL_SERVICE_TOKEN".to_string(),
        preserve_secret(existing, "PORTAL_SERVICE_TOKEN", 32),
    );
    env.insert(
        "PORTAL_USERNAME".to_string(),
        existing_or(existing, "PORTAL_USERNAME", ""),
    );
    env.insert(
        "PORTAL_PASSWORD".to_string(),
        existing_or(existing, "PORTAL_PASSWORD", ""),
    );
    env.insert(
        "PORTAL_REALM".to_string(),
        existing_or(existing, "PORTAL_REALM", "FRAME Portal"),
    );
    env.insert(
        "ENABLE_CONTAINER_RESTARTS".to_string(),
        existing_or(existing, "ENABLE_CONTAINER_RESTARTS", "false"),
    );
    env.insert(
        "DOCKER_PROXY_POST".to_string(),
        existing_or(existing, "DOCKER_PROXY_POST", "0"),
    );
    env.insert(
        "STATUS_REFRESH_MS".to_string(),
        existing_or(existing, "STATUS_REFRESH_MS", "5000"),
    );
    env.insert(
        "STATUS_CACHE_MS".to_string(),
        existing_or(existing, "STATUS_CACHE_MS", "4000"),
    );
    env.insert(
        "REQUEST_TIMEOUT_MS".to_string(),
        existing_or(existing, "REQUEST_TIMEOUT_MS", "3000"),
    );
    env.insert(
        "DISK_WARN_PERCENT".to_string(),
        existing_or(existing, "DISK_WARN_PERCENT", "85"),
    );
    env.insert(
        "DISK_ERROR_PERCENT".to_string(),
        existing_or(existing, "DISK_ERROR_PERCENT", "95"),
    );
    env.insert(
        "DISK_MINIMUM_FREE_GB".to_string(),
        existing_or(existing, "DISK_MINIMUM_FREE_GB", "20"),
    );
    env.insert(
        "DISCORD_TOKEN".to_string(),
        existing_or(existing, "DISCORD_TOKEN", "your_bot_token_here"),
    );
    env.insert(
        "DISCORD_CLIENT_ID".to_string(),
        existing_or(
            existing,
            "DISCORD_CLIENT_ID",
            "your_discord_application_client_id_here",
        ),
    );
    env.insert(
        "PUBLIC_BASE_URL".to_string(),
        if mode == "HYBRID" {
            edge_public_base_url.clone()
        } else {
            format!("http://localhost:{audio_bridge_port}")
        },
    );
    env.insert(
        "SESSION_SECRET".to_string(),
        preserve_secret(existing, "SESSION_SECRET", 32),
    );
    env.insert(
        "DEFAULT_AUDIO_DELAY_MS".to_string(),
        existing_or(existing, "DEFAULT_AUDIO_DELAY_MS", "2000"),
    );
    env.insert(
        "MAX_AUDIO_DELAY_MS".to_string(),
        existing_or(existing, "MAX_AUDIO_DELAY_MS", "10000"),
    );
    env.insert(
        "SESSION_IDLE_TIMEOUT_MINUTES".to_string(),
        existing_or(existing, "SESSION_IDLE_TIMEOUT_MINUTES", "30"),
    );
    env.insert(
        "READONLY_OBS_TOKEN".to_string(),
        existing_or(existing, "READONLY_OBS_TOKEN", ""),
    );
    env.insert(
        "SLS_API_KEY".to_string(),
        preserve_secret(existing, "SLS_API_KEY", 32),
    );
    env.insert(
        "PUBLIC_RELAY_HOST".to_string(),
        existing_or(
            existing,
            "PUBLIC_RELAY_HOST",
            if mode == "HYBRID" {
                plan.public_hostname.trim()
            } else {
                "localhost"
            },
        ),
    );
    env.insert(
        "SRTLA_PORT".to_string(),
        validate_port(plan.ports.srtla, "SRTLA port")?.to_string(),
    );
    env.insert(
        "SRT_PLAYER_PORT".to_string(),
        validate_port(plan.ports.srt_player, "SRT player port")?.to_string(),
    );
    env.insert(
        "SRT_SENDER_PORT".to_string(),
        validate_port(plan.ports.srt_sender, "SRT sender port")?.to_string(),
    );
    env.insert(
        "SLS_STATS_PORT".to_string(),
        existing_or(existing, "SLS_STATS_PORT", "8080"),
    );
    env.insert(
        "STREAMS_USERNAME".to_string(),
        existing_or(existing, "STREAMS_USERNAME", ""),
    );
    env.insert(
        "STREAMS_PASSWORD".to_string(),
        existing_or(existing, "STREAMS_PASSWORD", ""),
    );
    env.insert("OVERLAYS_PUBLIC_BASE_URL".to_string(), edge_public_base_url);
    env.insert(
        "OVERLAYS_USERNAME".to_string(),
        existing_or(existing, "OVERLAYS_USERNAME", ""),
    );
    env.insert(
        "OVERLAYS_PASSWORD".to_string(),
        existing_or(existing, "OVERLAYS_PASSWORD", ""),
    );

    Ok(env)
}

fn validate_port(port: u16, label: &str) -> Result<u16, String> {
    if port == 0 {
        Err(format!("{label} must be between 1 and 65535."))
    } else {
        Ok(port)
    }
}

fn existing_or(existing: &BTreeMap<String, String>, key: &str, fallback: &str) -> String {
    existing
        .get(key)
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

fn advanced_setting_or(
    plan: &InstallPlan,
    existing: &BTreeMap<String, String>,
    key: &str,
    fallback: &str,
    minimum: u32,
    maximum: u32,
    label: &str,
) -> Result<String, String> {
    let value = plan
        .advanced_settings
        .get(key)
        .filter(|candidate| !candidate.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| existing_or(existing, key, fallback));
    validate_integer_string(&value, minimum, maximum, label)
}

fn validate_integer_string(
    value: &str,
    minimum: u32,
    maximum: u32,
    label: &str,
) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed != value {
        return Err(format!("{label} must be an integer from {minimum} to {maximum}."));
    }
    let integer = trimmed
        .parse::<u32>()
        .map_err(|_| format!("{label} must be an integer from {minimum} to {maximum}."))?;
    if integer < minimum || integer > maximum {
        return Err(format!("{label} must be an integer from {minimum} to {maximum}."));
    }
    Ok(integer.to_string())
}

fn preserve_secret(
    existing: &BTreeMap<String, String>,
    key: &str,
    minimum_length: usize,
) -> String {
    let placeholder_values = [
        "",
        "your_bot_token_here",
        "your_discord_application_client_id_here",
        "replace_with_a_long_random_value",
    ];
    if let Some(value) = existing.get(key) {
        if value.len() >= minimum_length && !placeholder_values.contains(&value.as_str()) {
            return value.clone();
        }
    }
    pseudo_secret(key, minimum_length.max(32))
}

fn pseudo_secret(label: &str, length: usize) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let seed = format!("{label}:{now}:{}", std::process::id());
    let mut hash = seed.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    let mut output = String::new();
    while output.len() < length {
        hash = hash
            .wrapping_mul(0x100000001b3)
            .wrapping_add(0x9e3779b97f4a7c15);
        output.push_str(&format!("{hash:016x}"));
    }
    output.truncate(length);
    output
}

fn path_to_env(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

fn format_local_http_url(port: u16) -> String {
    if port == 80 {
        "http://localhost".to_string()
    } else {
        format!("http://localhost:{port}")
    }
}

fn is_valid_public_hostname(hostname: &str) -> bool {
    if hostname.is_empty()
        || hostname.len() > 253
        || hostname.contains("://")
        || hostname.contains('/')
        || hostname.contains(':')
        || hostname.contains(' ')
        || hostname.ends_with('.')
        || !hostname.contains('.')
    {
        return false;
    }
    let labels = hostname.split('.').collect::<Vec<_>>();
    let Some(top_level) = labels.last() else {
        return false;
    };
    if top_level.len() < 2
        || top_level.len() > 63
        || !top_level
            .chars()
            .all(|character| character.is_ascii_lowercase())
    {
        return false;
    }
    labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
            })
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

fn serialize_env(env: &BTreeMap<String, String>) -> String {
    let sections: &[(&str, &[&str])] = &[
        (
            "FRAME stack",
            &[
                "FRAME_MODE",
                "FRAME_DATA_ROOT",
                "FRAME_HOST_DATA_ROOT",
                "TIMEZONE",
                "COMPOSE_PROFILES",
            ],
        ),
        (
            "FRAME Edge",
            &[
                "EDGE_HTTP_PORT",
                "EDGE_PUBLIC_BASE_URL",
                "EDGE_LAN_BASE_URL",
            ],
        ),
        (
            "FRAME Auth",
            &["FRAME_AUTH_SESSION_SECRET", "FRAME_AUTH_SESSION_DAYS"],
        ),
        (
            "Cloudflare Tunnel",
            &["CLOUDFLARE_PUBLIC_HOSTNAME", "CLOUDFLARE_TUNNEL_ORIGIN"],
        ),
        (
            "Direct service ports",
            &[
                "PORTAL_PORT",
                "AUDIO_BRIDGE_PORT",
                "AUDIO_MONITOR_PORT",
                "STREAMS_PORT",
                "OVERLAYS_PORT",
                "PHOTO_UPLOAD_PORT",
                "PHOTO_FTP_PORT",
                "GALLERY_PORT",
                "TODAY_PORT",
            ],
        ),
        (
            "Audio Monitor",
            &["AUDIO_PUBLIC_BASE_URL", "AUDIO_CAPTURE_BASE_URL"],
        ),
        (
            "Photo workflow",
            &[
                "PHOTO_FTP_PASSIVE_MIN",
                "PHOTO_FTP_PASSIVE_MAX",
                "PHOTO_FTP_PASSIVE_HOST",
                "PHOTO_FTP_USERNAME",
                "PHOTO_FTP_PASSWORD",
                "PHOTO_FTP_MIN_PASSWORD_LENGTH",
                "PHOTO_FTP_MAX_SESSIONS",
                "PHOTO_FTP_MAX_SESSIONS_PER_IP",
                "PHOTO_FTP_VERBOSE_LOG",
                "PHOTO_FTP_STABLE_MS",
                "PHOTO_FTP_SCAN_MS",
                "PHOTO_UPLOAD_MAX_FILES",
                "PHOTO_UPLOAD_MAX_SESSIONS",
                "PIPELINE_POLL_MS",
                "PIPELINE_CONCURRENCY",
                "PHOTO_MAX_INPUT_MB",
                "PHOTO_MAX_MEGAPIXELS",
                "PHOTO_CONVERSION_ATTEMPTS",
                "PHOTO_ARCHIVE_ORIGINALS",
                "GALLERY_THUMB_WIDTH",
                "GALLERY_THUMB_QUALITY",
                "TODAY_DEFAULT_INTERVAL_MS",
                "TODAY_REFRESH_MS",
            ],
        ),
        (
            "Portal",
            &[
                "PORTAL_SERVICE_TOKEN",
                "PORTAL_USERNAME",
                "PORTAL_PASSWORD",
                "PORTAL_REALM",
                "ENABLE_CONTAINER_RESTARTS",
                "DOCKER_PROXY_POST",
                "STATUS_REFRESH_MS",
                "STATUS_CACHE_MS",
                "REQUEST_TIMEOUT_MS",
                "DISK_WARN_PERCENT",
                "DISK_ERROR_PERCENT",
                "DISK_MINIMUM_FREE_GB",
            ],
        ),
        (
            "Discord Audio Bridge",
            &[
                "DISCORD_TOKEN",
                "DISCORD_CLIENT_ID",
                "PUBLIC_BASE_URL",
                "SESSION_SECRET",
                "DEFAULT_AUDIO_DELAY_MS",
                "MAX_AUDIO_DELAY_MS",
                "SESSION_IDLE_TIMEOUT_MINUTES",
                "READONLY_OBS_TOKEN",
            ],
        ),
        (
            "Video Relay",
            &[
                "SLS_API_KEY",
                "PUBLIC_RELAY_HOST",
                "SRTLA_PORT",
                "SRT_PLAYER_PORT",
                "SRT_SENDER_PORT",
                "SLS_STATS_PORT",
                "STREAMS_USERNAME",
                "STREAMS_PASSWORD",
            ],
        ),
        (
            "Overlays",
            &[
                "OVERLAYS_PUBLIC_BASE_URL",
                "OVERLAYS_USERNAME",
                "OVERLAYS_PASSWORD",
            ],
        ),
    ];
    let mut output = vec!["# Generated and maintained by the FRAME installer.".to_string()];
    for (heading, keys) in sections {
        output.push(String::new());
        output.push(format!("# {heading}"));
        for key in *keys {
            output.push(format!(
                "{key}={}",
                format_env_value(env.get(*key).map(String::as_str).unwrap_or(""))
            ));
        }
    }
    output.push(String::new());
    output.join("\n")
}

fn format_env_value(value: &str) -> String {
    if value.chars().any(|character| {
        character.is_whitespace()
            || character == '#'
            || character == '"'
            || character == '\''
            || character == '\\'
    }) {
        serde_json::to_string(value)
            .unwrap_or_else(|_| format!("\"{}\"", value.replace('"', "\\\"")))
    } else {
        value.to_string()
    }
}

fn generate_public_routes(prefixes: &[String]) -> String {
    let root_router = if prefixes.iter().any(|prefix| prefix == "/dashboard") {
        "    frame-public-root:\n      entryPoints:\n        - public\n      rule: \"Path(`/`)\"\n      priority: 110\n      service: frame-edge\n"
            .to_string()
    } else {
        String::new()
    };
    let public_router = if prefixes.is_empty() {
        String::new()
    } else {
        let rule = prefixes
            .iter()
            .map(|prefix| format!("(Path(`{prefix}`) || PathPrefix(`{prefix}/`))"))
            .collect::<Vec<_>>()
            .join(" || ");
        format!(
            "    frame-public:\n      entryPoints:\n        - public\n      rule: \"{rule}\"\n      priority: 100\n      service: frame-edge\n"
        )
    };
    format!(
        "# Generated by FRAME installer. Do not edit by hand.\nhttp:\n  routers:\n    frame-public-gateway-health:\n      entryPoints:\n        - health\n      rule: \"Path(`/__frame_gateway_health`)\"\n      middlewares:\n        - frame-public-gateway-health-path\n      service: frame-edge\n{root_router}{public_router}  middlewares:\n    frame-public-gateway-health-path:\n      replacePath:\n        path: /healthz\n  services:\n    frame-edge:\n      loadBalancer:\n        passHostHeader: true\n        servers:\n          - url: http://frame-edge:80\n"
    )
}

fn generate_cloudflared_ingress(env: &BTreeMap<String, String>, prefixes: &[String]) -> String {
    if env.get("FRAME_MODE").map(String::as_str) != Some("HYBRID") {
        return "# Generated by FRAME installer. LAN mode exposes no tunnel routes.\ningress:\n  - service: http_status:404\n".to_string();
    }
    let hostname = env
        .get("CLOUDFLARE_PUBLIC_HOSTNAME")
        .map(String::as_str)
        .unwrap_or("");
    let origin = env
        .get("CLOUDFLARE_TUNNEL_ORIGIN")
        .map(String::as_str)
        .unwrap_or("http://frame-public-gateway:8080");
    format!(
        "# Reference for the remotely managed FRAME tunnel.\n# In Cloudflare Published applications, route {hostname} to {origin}.\n# FRAME Public Gateway enforces: {}\ningress:\n  - hostname: {hostname}\n    service: {origin}\n  - service: http_status:404\n",
        if prefixes.is_empty() { "no routes".to_string() } else { prefixes.join(", ") }
    )
}

fn run_compose_config(
    app: &AppHandle,
    repo_root: &Path,
    logs: &mut Vec<String>,
) -> Result<(), String> {
    run_logged_command(
        app,
        repo_root,
        logs,
        "docker",
        &[
            "compose",
            "--env-file",
            ".env",
            "-f",
            "docker-compose.yml",
            "config",
            "--quiet",
        ],
    )
}

fn run_compose_up(app: &AppHandle, repo_root: &Path, logs: &mut Vec<String>) -> Result<(), String> {
    run_logged_command(
        app,
        repo_root,
        logs,
        "docker",
        &[
            "compose",
            "--env-file",
            ".env",
            "-f",
            "docker-compose.yml",
            "up",
            "-d",
            "--build",
            "--remove-orphans",
        ],
    )
}

fn run_logged_command(
    app: &AppHandle,
    repo_root: &Path,
    logs: &mut Vec<String>,
    command: &str,
    args: &[&str],
) -> Result<(), String> {
    push_install_log(app, logs, format!("Running: {command} {}", args.join(" ")));
    let mut child = hidden_command(command)
        .args(args)
        .current_dir(repo_root)
        .env("BUILDKIT_PROGRESS", "plain")
        .env("COMPOSE_PROGRESS", "plain")
        .env("DOCKER_BUILDKIT", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not run {command}: {error}"))?;

    let (sender, receiver) = mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        let sender = sender.clone();
        thread::spawn(move || stream_command_output(stdout, sender));
    }
    if let Some(stderr) = child.stderr.take() {
        let sender = sender.clone();
        thread::spawn(move || stream_command_output(stderr, sender));
    }
    drop(sender);

    for line in receiver {
        push_install_log(app, logs, line);
    }

    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for {command}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{command} {} failed with status {}.",
            args.join(" "),
            status
        ))
    }
}

fn stream_command_output<T: std::io::Read + Send + 'static>(
    stream: T,
    sender: mpsc::Sender<String>,
) {
    let reader = BufReader::new(stream);
    for line in reader.lines().map_while(Result::ok) {
        if !line.trim().is_empty() {
            let _ = sender.send(line);
        }
    }
}

fn setup_url(plan: &InstallPlan) -> String {
    if plan.ports.edge == 80 {
        "http://localhost/setup".to_string()
    } else {
        format!("http://localhost:{}/setup", plan.ports.edge)
    }
}
