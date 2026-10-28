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

/// Whether this launch is the old build relaunched mid-install. Every signal must agree: the
/// marker names this version, it is fresh, and the updater process is running. A failed
/// install would otherwise strand the user on the splash. `updater_alive` runs last, so a
/// normal boot never shells out.
pub fn should_guard(
    marker: Option<&PendingInstall>,
    current: &str,
    now_ms: i64,
    updater_alive: impl FnOnce() -> bool,
) -> bool {
    let Some(marker) = marker else {
        return false;
    };
    // A marker from the future (clock moved back, hand-edited file) is not fresh, and an absurd
    // timestamp must not overflow into "fresh".
    let fresh = now_ms
        .checked_sub(marker.created_at)
        .is_some_and(|age| (0..=PENDING_INSTALL_FRESH_MS).contains(&age));
    marker.from_version == current && fresh && updater_alive()
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

    #[test]
    fn fires_when_every_signal_agrees_the_install_is_in_flight() {
        assert!(should_guard(Some(&marker()), VERSION, 2_000, || true));
        assert!(should_guard(
            Some(&marker()),
            VERSION,
            1_000 + PENDING_INSTALL_FRESH_MS,
            || true
        ));
    }

    #[test]
    fn does_not_fire_without_a_marker_or_once_the_version_moved_on() {
        let never = || panic!("cheap checks fail first");
        assert!(!should_guard(None, VERSION, 2_000, never));
        assert!(!should_guard(Some(&marker()), "2026.702.4", 2_000, never));
    }

    #[test]
    fn does_not_fire_for_a_stale_marker() {
        let stale = 1_000 + PENDING_INSTALL_FRESH_MS + 1;
        assert!(!should_guard(Some(&marker()), VERSION, stale, || panic!(
            "no pgrep for a stale marker"
        )));
    }

    #[test]
    fn does_not_fire_for_a_marker_from_the_future() {
        let ahead = PendingInstall {
            from_version: VERSION.into(),
            created_at: 2_000 + 60 * 60 * 1000,
        };
        assert!(!should_guard(Some(&ahead), VERSION, 2_000, || panic!(
            "no pgrep for a future marker"
        )));
    }

    #[test]
    fn an_absurd_timestamp_is_stale_and_never_overflows() {
        let cases = [
            (i64::MIN, [0, 2_000, i64::MAX]),
            (i64::MAX, [i64::MIN, 0, 2_000]),
        ];
        for (created_at, nows) in cases {
            let marker = PendingInstall {
                from_version: VERSION.into(),
                created_at,
            };
            for now in nows {
                assert!(
                    !should_guard(Some(&marker), VERSION, now, || true),
                    "{created_at} {now}"
                );
            }
        }
        // `-1e300` in the file saturates to `i64::MIN`.
        let parsed = parse(br#"{"fromVersion":"2026.702.2","createdAt":-1e300}"#).unwrap();
        assert!(!should_guard(Some(&parsed), VERSION, 2_000, || true));
    }

    #[test]
    fn does_not_fire_when_no_updater_is_running() {
        assert!(!should_guard(Some(&marker()), VERSION, 2_000, || false));
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
