# FRAME backup and restore

A full backup contains the managed FRAME application/deployment folder and the entire persistent
data folder: settings, credentials, databases, photos, galleries, inbox, staging, archives, and logs.
It is a directory with a `frame-full-backup.json` completion manifest and verified file hashes.
Docker images, the launcher application, and update/recovery snapshots are separate.

Backups contain passwords and tokens and are not encrypted. Choose a private destination, preferably
on another physical drive or an encrypted volume. On Windows, destination permissions are inherited;
POSIX backup files are private to the current user. Do not send a full backup as a support report.

## Create and verify a backup

1. Connect the storage containing FRAME's data and the backup destination. Finish any pending
   installation/update recovery first. Close other programs that write into the FRAME folders.
2. Open **Backup & removal**, choose an empty folder outside the deployment and data folders, then
   choose **Create full backup**. Confirm the interruption. All FRAME services stop during the copy;
   the time depends on the library size and drive speed.
3. Wait for the completed result. The launcher verifies copied files before marking the backup
   complete, then resumes only the containers that were previously running. A deliberately stopped
   service remains stopped. A failed resume is reported separately from a successful backup.
4. Choose **Choose backup to restore** to verify the completed backup and review its timestamp,
   original destinations, and file totals without restoring anything. Keep the backup directory intact.

If copying fails, that backup remains incomplete and cannot be restored. Preserve it for inspection
or remove that specific incomplete copy yourself, then select another empty folder and retry.
If the launcher/computer exits during copying, FRAME may remain stopped; reopen the launcher,
check its status, and explicitly start it when ready. A completed backup is not invalidated by a
later failure to resume services. Do not disconnect storage while an operation is active.

## Restore into empty original folders

This first restore workflow supports the same operating system and original deployment/data paths.
It is not an automatic migration between hosts, operating systems, Docker architectures, or folder
layouts. Docker must be ready with a compatible Linux-container architecture before restore.

1. Keep the backup separate. Verify it using **Choose backup to restore** before moving anything.
2. If the old installation still has containers, select **Remove FRAME containers** and confirm.
   This retains application files, configuration, data, and Docker images.
3. In the file manager, move the old deployment and data folders aside to clearly named retained
   folders. Do not delete them yet. Ensure both original destinations are absent or empty. When
   the data folder is inside deployment, retain that complete folder tree together.
4. Select the backup again and check the displayed original destinations. Choose **Restore backup**
   and confirm. Every source file is verified before destination copying. The launcher refuses
   nonempty destinations and linked/special files, and leaves an interrupted-restore marker if copying
   cannot complete. An interrupted restore must not be treated as an installed deployment.
5. After successful restoration, open **Updates & repair** and choose **Repair installation**.
   Repair recreates containers using the backed-up release's exact images; internet access may be
   needed to retrieve missing images. Services remain stopped until **Start FRAME** is selected.
6. Check service health and then the actual tools, saved settings, credentials, library files, and
   media workflows. Keep the old folders and backup until that acceptance check is complete.

If restore fails, leave the original backup unchanged. Move the incomplete destination folders
aside and retry into empty original paths. Resolve any storage/permission errors first. On POSIX
systems, original ownership and modes must be restorable; do not broadly loosen permissions.

## Removal choices

| Action | Result |
| --- | --- |
| Quit/uninstall launcher | Monitoring ends; FRAME containers retain their current state. Deployment and data remain. |
| Stop FRAME | Stops services and keeps containers, settings, media, and images. |
| Remove FRAME containers | Stops and removes verified FRAME containers. Files, settings, media, images, and unrelated Docker resources remain. |
| Permanently delete FRAME data | Separate manual action in the file manager after container removal and backup. This is irreversible. |

Reinstalling the launcher reconnects to a retained managed deployment through its default location,
saved registry, or owned containers. If the launcher registry and containers were both removed from
a custom-location installation, use **My Setup → Locate existing installation** to select its original deployment folder. Docker itself is
never uninstalled by FRAME. Remove unused Docker images separately through Docker only when they are
no longer needed for update recovery or another application.

## Verification scope

Automated tests exercise binary/large-file copying, complete persistent data, empty directories,
file hashes, path overlap, links/junctions, incomplete backups/restores, original-path restrictions,
container ownership, stop/resume choices, and removal preserving files/images. These use temporary
folders and simulated Docker. Before a public release, perform the create/remove/restore/repair/start
sequence on each supported OS with a real database and media library, including interrupted storage
and a failed service restart. Keep the original data until that test succeeds.
