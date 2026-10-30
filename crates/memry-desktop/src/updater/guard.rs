//! The macOS relaunch guard (`apps/desktop/src/main/updater-install-guard.ts`). The Dock icon
//! vanishes while the updater swaps the bundle, and a user who relaunches the old build then
//! keeps the old process alive, which makes the swap abort and the update prompt return. When
//! an install started by this very build is still in flight, the launch shows a splash and
//! exits instead of booting.
//!
//! The guard is Tauri-only. It keeps Electron's file name and keys, but no shipped Electron
//! build writes the file: `writePendingInstallMarker` lost its caller in #681. Electron
//! corroborated with Squirrel's `ShipItState.plist`; Velopack's updater has no state file, so a
//! live updater process is the only signal next to the marker.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

pub const PENDING_INSTALL_FILENAME: &str = "pending-update-install.json";

/// How long an install counts as in flight. The real install takes about 11 s; past this a
/// leftover marker is an aborted install and must not keep the app from opening.
pub const PENDING_INSTALL_FRESH_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInstall {
    /// Raw version of the build that started the install.
    pub from_version: String,
    /// Epoch milliseconds.
    pub created_at: i64,
}

fn path(dir: &Path) -> PathBuf {
    dir.join(PENDING_INSTALL_FILENAME)
}

pub fn parse(raw: &[u8]) -> Option<PendingInstall> {
    let value: Value = serde_json::from_slice(raw).ok()?;
    Some(PendingInstall {
        from_version: value.get("fromVersion")?.as_str()?.to_owned(),
        created_at: value.get("createdAt")?.as_f64()? as i64,
    })
}

/// A missing or corrupt marker is no pending install.
pub fn read(dir: &Path) -> Option<PendingInstall> {
    parse(&super::read_marker(&path(dir))?)
}

/// Records that this build handed the install to the updater. Best effort and not atomic: a
/// failed or torn write only disables the guard.
pub fn write(dir: &Path, from: &str, now_ms: i64) {
    let marker = PendingInstall {
        from_version: from.to_owned(),
        created_at: now_ms,
    };
    let result = serde_json::to_vec(&marker)
        .map_err(std::io::Error::other)
        .and_then(|bytes| std::fs::write(path(dir), bytes));
    if let Err(error) = result {
        tracing::warn!(
            scope = "UpdaterGuard",
            "failed to write the pending-install marker: {error}"
        );
    }
}

/// A normal boot commits: the marker has served its purpose.
pub fn clear(dir: &Path) {
    match std::fs::remove_file(path(dir)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(
            scope = "UpdaterGuard",
            "failed to clear the pending-install marker: {error}"
        ),
    }
}

/// How long the process probe may take. Past it the updater counts as not running, so a hung
/// probe costs the guard, never the launch.
pub const UPDATER_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether Velopack's updater of this bundle runs: `pgrep -f` for an `UpdateMac` whose
/// `--root` is this bundle. Velopack starts `<bundle>/Contents/MacOS/UpdateMac apply ... --root
/// <bundle> --packageDir ...` (velopack `manager.rs` `unsafe_apply_updates`); matching the root
/// rather than the executable path also finds an updater run from a copy, and never a process
/// that only names the path (a `tail -f` of its log). A timeout, a failed spawn or any answer but
/// "found" is not running: the guard fails open (`isShipItProcessAlive`).
#[cfg(unix)]
pub fn updater_alive(bundle: &Path) -> bool {
    let pattern = format!(
        "UpdateMac .*--root {}( |$)",
        regex::escape(&bundle.to_string_lossy())
    );
    // The absolute path: a launch from Finder or the Dock gets a minimal `PATH`.
    let child = std::process::Command::new("/usr/bin/pgrep")
        .arg("-f")
        .arg(pattern)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(scope = "UpdaterGuard", "could not run pgrep: {error}");
            return false;
        }
    };
    let deadline = std::time::Instant::now() + UPDATER_PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            // 0: a process matched; 1: none did. Anything else is pgrep failing.
            Ok(Some(status)) => match status.code() {
                Some(0) => return true,
                Some(1) => return false,
                _ => {
                    tracing::warn!(
                        scope = "UpdaterGuard",
                        "pgrep failed, the updater counts as not running: {status}"
                    );
                    return false;
                }
            },
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            outcome => {
                tracing::warn!(
                    scope = "UpdaterGuard",
                    "pgrep gave no answer, the updater counts as not running: {outcome:?}"
                );
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Why the guard holds a launch back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InFlight {
    /// The updater of this bundle is running.
    Updating,
    /// The bundle on disk is no longer the one this process started from: the swap finished
    /// between the launch and the guard, and this process would boot old code on new files.
    Replaced,
}

/// Whether this launch is the old build relaunched mid-install, and why. Every signal must
/// agree: the marker names the version this process started as, it is fresh, the updater did
/// not start this launch, and the install is visibly under way. A failed install would otherwise
/// strand the user on the splash. The checks on disk run last and in order of cost, so a normal
/// boot never reads the bundle or shells out.
///
/// `started_as`: the installed version when this process started (`sq.version`, read at the top
/// of `main`), not when the guard runs. The swap takes a second or two, and a launch can start
/// before it and reach the guard after it.
///
/// `launched_by_updater`: Velopack's updater starts the app itself after Restart to install,
/// and after a failed swap it starts the old build while it is still exiting
/// (velopack `commands/apply.rs`), so that launch would otherwise find a live updater.
pub fn in_flight(
    marker: Option<&PendingInstall>,
    started_as: &str,
    now_ms: i64,
    launched_by_updater: bool,
    installed_now: impl FnOnce() -> Option<String>,
    updater_alive: impl FnOnce() -> bool,
) -> Option<InFlight> {
    let marker = marker?;
    if launched_by_updater {
        return None;
    }
    // A marker from the future (clock moved back, hand-edited file) is not fresh, and an absurd
    // timestamp must not overflow into "fresh". So a clock stepped back after the write turns the
    // guard off for that launch: the old build boots during the swap, which the guard exists to
    // prevent, but only in that rare case.
    let fresh = now_ms
        .checked_sub(marker.created_at)
        .is_some_and(|age| (0..=PENDING_INSTALL_FRESH_MS).contains(&age));
    if marker.from_version != started_as || !fresh {
        return None;
    }
    // An unreadable bundle proves nothing: the updater decides.
    if installed_now().is_some_and(|now| now != started_as) {
        return Some(InFlight::Replaced);
    }
    updater_alive().then_some(InFlight::Updating)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERSION: &str = "2026.702.2";

    fn marker() -> PendingInstall {
        PendingInstall {
            from_version: VERSION.into(),
            created_at: 1_000,
        }
    }

    /// The bundle on disk still holds the version the launch started as.
    fn unchanged() -> Option<String> {
        Some(VERSION.into())
    }

    fn decide(
        marker: Option<&PendingInstall>,
        started_as: &str,
        now_ms: i64,
        installed_now: Option<&str>,
        updater_alive: bool,
    ) -> Option<InFlight> {
        in_flight(
            marker,
            started_as,
            now_ms,
            false,
            || installed_now.map(str::to_owned),
            || updater_alive,
        )
    }

    #[test]
    fn fires_while_the_updater_of_an_unchanged_bundle_runs() {
        assert_eq!(
            decide(Some(&marker()), VERSION, 2_000, Some(VERSION), true),
            Some(InFlight::Updating)
        );
        assert_eq!(
            decide(
                Some(&marker()),
                VERSION,
                1_000 + PENDING_INSTALL_FRESH_MS,
                Some(VERSION),
                true
            ),
            Some(InFlight::Updating)
        );
        // An unreadable bundle leaves the decision to the updater.
        assert_eq!(
            decide(Some(&marker()), VERSION, 2_000, None, true),
            Some(InFlight::Updating)
        );
        assert_eq!(decide(Some(&marker()), VERSION, 2_000, None, false), None);
    }

    /// #3729: the launch started before the swap and reaches the guard after it, when the
    /// updater may already be gone.
    #[test]
    fn fires_for_a_launch_whose_bundle_was_replaced_after_it_started() {
        assert_eq!(
            in_flight(
                Some(&marker()),
                VERSION,
                2_000,
                false,
                || Some("2026.702.4".into()),
                || panic!("the replaced bundle needs no pgrep")
            ),
            Some(InFlight::Replaced)
        );
    }

    #[test]
    fn does_not_fire_without_a_marker_or_for_a_launch_of_the_new_build() {
        let never = || panic!("cheap checks fail first");
        assert_eq!(in_flight(None, VERSION, 2_000, false, never, || true), None);
        // Started after the swap: the new build boots and clears the marker.
        assert_eq!(
            in_flight(Some(&marker()), "2026.702.4", 2_000, false, never, || true),
            None
        );
    }

    #[test]
    fn does_not_fire_for_a_stale_marker() {
        let stale = 1_000 + PENDING_INSTALL_FRESH_MS + 1;
        assert_eq!(
            in_flight(
                Some(&marker()),
                VERSION,
                stale,
                false,
                || panic!("no bundle read for a stale marker"),
                || panic!("no pgrep for a stale marker")
            ),
            None
        );
    }

    #[test]
    fn does_not_fire_for_a_marker_from_the_future() {
        let ahead = PendingInstall {
            created_at: 2_000 + 60 * 60 * 1000,
            ..marker()
        };
        assert_eq!(
            in_flight(
                Some(&ahead),
                VERSION,
                2_000,
                false,
                || panic!("no bundle read for a future marker"),
                || panic!("no pgrep for a future marker")
            ),
            None
        );
    }

    #[test]
    fn an_absurd_timestamp_is_stale_and_never_overflows() {
        let cases = [
            (i64::MIN, [0, 2_000, i64::MAX]),
            (i64::MAX, [i64::MIN, 0, 2_000]),
        ];
        for (created_at, nows) in cases {
            let marker = PendingInstall {
                created_at,
                ..marker()
            };
            for now in nows {
                assert_eq!(
                    decide(Some(&marker), VERSION, now, Some("2026.702.4"), true),
                    None,
                    "{created_at} {now}"
                );
            }
        }
        // `-1e300` in the file saturates to `i64::MIN`.
        let parsed = parse(br#"{"fromVersion":"2026.702.2","createdAt":-1e300}"#).unwrap();
        assert_eq!(
            decide(Some(&parsed), VERSION, 2_000, Some("2026.702.4"), true),
            None
        );
    }

    /// A failed or aborted install: the bundle is unchanged and no updater runs.
    #[test]
    fn does_not_fire_when_no_updater_is_running_and_the_bundle_is_unchanged() {
        assert_eq!(
            in_flight(Some(&marker()), VERSION, 2_000, false, unchanged, || false),
            None
        );
    }

    /// After a failed swap the updater starts the old build and exits: every other signal says
    /// the install is in flight. After Restart to install it starts the new build.
    #[test]
    fn does_not_fire_for_the_launch_the_updater_started() {
        let never = || panic!("the updater's own launch boots");
        assert_eq!(
            in_flight(Some(&marker()), VERSION, 2_000, true, never, || true),
            None
        );
    }

    /// A process that looks like the updater, started as `UpdateMac` with this bundle as its
    /// root, from the bundle or from a copy elsewhere.
    #[cfg(unix)]
    fn fake_updater(exe: &Path, root: &Path) -> std::process::Child {
        use std::os::unix::process::CommandExt;
        // `; :` keeps the shell from replacing itself with `sleep`, which would drop the arguments.
        std::process::Command::new("/bin/sh")
            .arg0(exe)
            .args(["-c", "sleep 30; :", "apply", "--root"])
            .arg(root)
            .args(["--packageDir", "/tmp/packages"])
            .spawn()
            .unwrap()
    }

    #[cfg(unix)]
    fn seen_within_a_second(bundle: &Path) -> bool {
        (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            updater_alive(bundle)
        })
    }

    /// In a bundle path with the characters a regex would read as syntax.
    #[cfg(unix)]
    #[test]
    fn finds_the_running_updater_of_this_bundle_only() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("Memry (rehearsal) [1]+.app");
        let other = root.path().join("Memry (rehearsal) [2]+.app");
        assert!(!updater_alive(&bundle));

        for exe in [
            bundle.join("Contents/MacOS/UpdateMac"),
            root.path().join("copy/UpdateMac"),
        ] {
            let mut updater = fake_updater(&exe, &bundle);
            let found = seen_within_a_second(&bundle);
            let other_found = updater_alive(&other);
            updater.kill().unwrap();
            updater.wait().unwrap();
            assert!(found, "the running updater is found: {exe:?}");
            assert!(!other_found, "another bundle does not match: {exe:?}");
        }
        assert!(!updater_alive(&bundle));
    }

    #[test]
    fn round_trips_the_marker() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "2026.1015.1", 1_793_525_415_123);
        assert_eq!(
            std::fs::read(path(dir.path())).unwrap(),
            br#"{"fromVersion":"2026.1015.1","createdAt":1793525415123}"#
        );
        assert_eq!(
            read(dir.path()),
            Some(PendingInstall {
                from_version: "2026.1015.1".into(),
                created_at: 1_793_525_415_123
            })
        );
        clear(dir.path());
        assert_eq!(read(dir.path()), None);
        clear(dir.path());
    }

    #[test]
    fn a_corrupt_marker_is_no_pending_install() {
        for raw in [
            &b"{\"fromVersion\":"[..],
            br#"{"fromVersion":"x","createdAt":"1"}"#,
            b"null",
        ] {
            assert_eq!(parse(raw), None);
        }
    }
}
