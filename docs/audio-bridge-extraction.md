# Audio Bridge extraction

Audio Bridge is now maintained in the independent **Syronius_FRAME_Audio_Bridge** project.
FRAME no longer builds, installs, routes, or monitors the bot. Audio Monitor and photo delivery
integrations remain part of FRAME. The new project is prepared separately; this source change
is not a deployment or a DNS change.

## Existing installations

Do not run a routine FRAME upgrade against an active legacy bridge until its separate cutover is
complete. FRAME uses Compose orphan cleanup during deployment, so the removed service must be
retired deliberately first. The installer blocks replacement when its old capability or Compose
profile is still enabled and the cutover acknowledgement below is absent.

1. Back up the complete bridge data directory (`<FRAME_DATA_ROOT>/audio-bridge`, or the legacy
   container's `/data` volume), the generated `.env`, and `state/stack-config.json`. Store the
   backup privately: guild configuration, permanent link keys, Discord credentials, and session
   secrets must survive. Do not delete or reset the old data root.
2. Prepare a separate installation of Syronius_FRAME_Audio_Bridge with its own persistent storage
   and Compose project. Copy the backup into that installation and use its documented data importer
   and database migration. Keep the original backup unchanged. A new hostname changes complete OBS
   URLs even when their link keys are preserved; plan redirects or update the affected sources.
3. Schedule the actual deployment separately. Verify private control links, OBS audio and overlays,
   permissions, database backup/restore, and restart recovery. Transfer the Discord bot connection
   deliberately so two running deployments do not use the same bot token concurrently.
4. After the standalone bot is validated, stop and remove only the old bridge container using its
   previous deployment definition. Keep all volumes, bind-mounted data, and backups. Confirm that
   any old routing has been replaced by the standalone routing.
5. Only after that cutover, create a UTF-8 file at
   `<FRAME_DATA_ROOT>/state/audio-bridge-extraction-complete` containing exactly
   `standalone-cutover-complete`. This explicit acknowledgement permits the FRAME configuration
   upgrade; it does not perform the migration or stop any container.
6. Bootstrap the updated FRAME installer/source as described below if this is a release-image
   installation from before extraction, then apply the FRAME configuration update. It retires the legacy capability, Compose profile,
   `/bridge` route, and generated bridge settings. Before replacing settings, the installer preserves
   the old environment and stack config under `state/audio-bridge-extraction/`, without overwriting
   an existing copy. On Unix those backup files are private. The old bridge data directory is left
   intact. Verify the standalone bot again before considering any later cleanup.

For a legacy installation where the bridge was never enabled, the update can proceed directly. Any
legacy bridge settings are still archived, and existing bridge data remains intact.

The migration acknowledgement is an operator assertion, not an automated check of Discord, DNS, or
the standalone service. Keep it absent until the separate cutover has actually completed. The
installer does not automatically start the standalone project, delete bridge data, or change public
DNS. `stack reset` removes a data root inside the FRAME workspace; external data roots are left
intact. Keep an independent backup and standalone storage outside the FRAME workspace and data root.

## Bootstrap an older release-image installation

Older FRAME installers require exactly 13 image entries and cannot accept a new 12-image release
manifest. The old `stack update --image-manifest` command validates the manifest before downloading
new helpers, so it cannot upgrade itself across this change. Installing only a new desktop app also
does not replace an existing installation's pinned source helpers. Complete the bridge cutover and
acknowledgement above first; do not repeatedly retry the old update command or fabricate a thirteenth
image entry.

Obtain the official extraction-aware FRAME release source and its matching 12-image
`frame-images.json`. Verify that the source archive/tag and manifest identify the intended release
commit. Keep the extracted source in a separate folder, and place the manifest in the existing
FRAME deployment folder. Keep the deployment's `.env`, data, old Compose definition, and recovery
backup intact. Use the updated source's helper with Node.js 22.12 or newer to update the existing
deployment without starting containers:

```sh
FRAME_WORKSPACE=/absolute/path/to/FRAME \
  node /absolute/path/to/updated-FRAME-source/installer/frame-installer.mjs \
  source-update --image-manifest frame-images.json
```

On Windows PowerShell, set `$env:FRAME_WORKSPACE` to the absolute existing deployment folder, invoke
`node` with the updated helper's absolute path and the same arguments, then remove that temporary
environment override. These commands target a deployment directory; the updater refuses a Git
checkout. For a developer checkout, update the source through Git instead.

The updated helper validates the new manifest, downloads and verifies its exact source commit,
preserves installation data/settings, and records the new release selection. It does not start the
stack. Use the refreshed FRAME launcher to apply configuration and run the normal deployment checks
only after inspecting the staged change. Keep the old source archive, image IDs and independent
backups until the new deployment is accepted.

Updated FRAME tools can read a historical manifest containing the retired bridge image if all 12
current images and every digest remain valid. That compatibility allows inspection and recovery;
new release downloads/activation still require the current 12-image inventory, and generated release
overrides never add the bridge. Explicit recovery can restore a previously running legacy bridge
from its saved snapshot, so avoid restarting a snapshot with the same Discord token as a live
standalone bot.
