//! Failed-install detection (`apps/desktop/src/main/telemetry/update-install-marker.ts`). The
//! installer runs after this process exits and after telemetry is disposed, so a failed install
//! reaches nobody. The quit path writes this marker synchronously; the next launch reads it and
//! compares versions. The file is a contract with Electron: the last Electron build writes it
//! before handing over to the first Tauri build.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shell::install_layout::WindowsInstallLayout;
use crate::telemetry::time::{iso, parse_iso};

pub const UPDATE_INSTALL_MARKER_FILENAME: &str = "update-install-attempt.json";

/// Which installer the quitting build handed off to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Installer {
    ElectronUpdater,
    Velopack,
    /// An Electron NSIS install migrating to Velopack.
    VelopackHandoff,
}

impl Installer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ElectronUpdater => "electron-updater",
            Self::Velopack => "velopack",
            Self::VelopackHandoff => "velopack-handoff",
        }
    }

    fn parse(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "electron-updater" => Some(Self::ElectronUpdater),
            "velopack" => Some(Self::Velopack),
            "velopack-handoff" => Some(Self::VelopackHandoff),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallAttempt {
    /// Raw version (`YYYY.MDD.N`) of the build that handed off: the one value the next launch
    /// compares itself against.
    pub from_version: String,
    /// Display version being installed. Reported as is, never compared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_version: Option<String>,
    pub started_at: String,
    /// Markers written by Electron builds before the hand-off lack it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer: Option<Installer>,
}

impl UpdateInstallAttempt {
    /// Milliseconds from the hand-off to `now`, when `startedAt` is a timestamp.
    pub fn duration_ms(&self, now_ms: u64) -> Option<u64> {
        parse_iso(&self.started_at).map(|started| now_ms.saturating_sub(started))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateInstallOutcome {
    Applied,
    DidNotApply,
    /// An NSIS install now runs from the Velopack layout.
    HandoffApplied,
    /// The update arrived, but through the NSIS fallback or a manual install.
    HandoffFellBack,
}

/// A marker the previous run left, already consumed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedInstall {
    pub attempt: UpdateInstallAttempt,
    pub outcome: UpdateInstallOutcome,
}

fn path(dir: &Path) -> PathBuf {
    dir.join(UPDATE_INSTALL_MARKER_FILENAME)
}

/// Lenient, as Electron reads it: an unknown installer is ignored and a missing `startedAt` is
/// empty. Without a `fromVersion` the verdict would be a coin flip, so that is `None`.
pub fn parse(raw: &[u8]) -> Option<UpdateInstallAttempt> {
    let value: Value = serde_json::from_slice(raw).ok()?;
    let from_version = value
        .get("fromVersion")?
        .as_str()
        .filter(|v| !v.is_empty())?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(UpdateInstallAttempt {
        from_version: from_version.to_owned(),
        to_version: text("toVersion"),
        started_at: text("startedAt").unwrap_or_default(),
        installer: value.get("installer").and_then(Installer::parse),
    })
}

/// Same version: the installer never applied. A hand-off marker on a new version proves the
/// migration only when the app now runs from the Velopack layout. The layout is a thunk
/// because only a hand-off marker needs the file system probe.
pub fn resolve_outcome(
    attempt: &UpdateInstallAttempt,
    current: &str,
    layout: impl FnOnce() -> WindowsInstallLayout,
) -> UpdateInstallOutcome {
    if attempt.from_version == current {
        UpdateInstallOutcome::DidNotApply
    } else if attempt.installer != Some(Installer::VelopackHandoff) {
        UpdateInstallOutcome::Applied
    } else if layout() == WindowsInstallLayout::Velopack {
        UpdateInstallOutcome::HandoffApplied
    } else {
        UpdateInstallOutcome::HandoffFellBack
    }
}

/// Records that this build is handing off to the installer. Synchronous because the process is
/// about to exit; a failed write is logged and never stops the install. A plain write, as in
/// Electron: a torn file reads as corrupt and is discarded, which only loses the diagnostic.
pub fn write_started(
    dir: &Path,
    from: &str,
    to: Option<&str>,
    installer: Option<Installer>,
    now_ms: u64,
) {
    let attempt = UpdateInstallAttempt {
        from_version: from.to_owned(),
        to_version: to.filter(|v| !v.is_empty()).map(str::to_owned),
        started_at: iso(now_ms),
        installer,
    };
    let result = serde_json::to_vec(&attempt)
        .map_err(std::io::Error::other)
        .and_then(|bytes| std::fs::write(path(dir), bytes));
    if let Err(error) = result {
        tracing::warn!(
            scope = "UpdateInstallMarker",
            "failed to record the update-install attempt; a failed install will go undetected: {error}"
        );
    }
}

/// Reads and consumes the previous run's marker, whatever the verdict, so a stale one can
/// neither pile up nor report twice. `None` when there was no marker or it was corrupt or
/// oversized.
pub fn detect(
    dir: &Path,
    current: &str,
    layout: impl FnOnce() -> WindowsInstallLayout,
) -> Option<DetectedInstall> {
    let path = path(dir);
    if !path.exists() {
        return None;
    }
    let raw = super::read_marker(&path);
    if let Err(error) = std::fs::remove_file(&path) {
        tracing::warn!(
            scope = "UpdateInstallMarker",
            "failed to clear the update-install marker; the next launch may report it again: {error}"
        );
    }
    let attempt = parse(&raw?)?;
    let outcome = resolve_outcome(&attempt, current, layout);
    Some(DetectedInstall { attempt, outcome })
}

#[cfg(test)]
mod tests {
    use super::*;
    use UpdateInstallOutcome::*;
    use WindowsInstallLayout::{Nsis, Unknown, Velopack};

    const ELECTRON: &str = "2026.1015.1";
    const TAURI: &str = "2026.1101.1";
    /// The instant the fixtures were written, 2026-11-01T09:30:15.123Z.
    const WRITTEN_AT: u64 = 1_793_525_415_123;

    fn fixture(name: &str) -> Vec<u8> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/electron/updater");
        std::fs::read(dir.join(name)).unwrap()
    }

    fn seeded(name: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), fixture(name)).unwrap();
        dir
    }

    #[test]
    fn the_last_electron_build_handing_off_to_tauri_is_applied() {
        for name in [
            "update-install-attempt.velopack.json",
            "update-install-attempt.electron-updater.json",
            "update-install-attempt.no-installer.json",
        ] {
            let dir = seeded(name);
            let detected = detect(dir.path(), TAURI, || unreachable!("{name}")).unwrap();
            assert_eq!(detected.outcome, Applied, "{name}");
            assert!(!path(dir.path()).exists(), "{name} consumed");
        }
    }

    #[test]
    fn an_nsis_hand_off_to_tauri_is_migrated_only_in_the_velopack_layout() {
        let dir = seeded("update-install-attempt.velopack-handoff.json");
        let detected = detect(dir.path(), TAURI, || Velopack).unwrap();
        assert_eq!(detected.outcome, HandoffApplied);
        assert_eq!(
            detected.attempt,
            UpdateInstallAttempt {
                from_version: ELECTRON.into(),
                to_version: Some("v2026-11-01".into()),
                started_at: "2026-11-01T09:30:15.123Z".into(),
                installer: Some(Installer::VelopackHandoff),
            }
        );
        for layout in [Nsis, Unknown] {
            let dir = seeded("update-install-attempt.velopack-handoff.json");
            assert_eq!(
                detect(dir.path(), TAURI, || layout).unwrap().outcome,
                HandoffFellBack
            );
        }
    }

    #[test]
    fn still_running_the_version_that_handed_off_did_not_apply() {
        let dir = seeded("update-install-attempt.velopack-handoff.json");
        let detected = detect(dir.path(), ELECTRON, || Nsis).unwrap();
        assert_eq!(detected.outcome, DidNotApply);
        assert_eq!(
            detected.attempt.duration_ms(WRITTEN_AT + 4_000),
            Some(4_000)
        );
    }

    #[test]
    fn writes_the_bytes_electron_writes() {
        let dir = tempfile::tempdir().unwrap();
        for (installer, name) in [
            (
                Some(Installer::VelopackHandoff),
                "update-install-attempt.velopack-handoff.json",
            ),
            (
                Some(Installer::ElectronUpdater),
                "update-install-attempt.electron-updater.json",
            ),
            (
                Some(Installer::Velopack),
                "update-install-attempt.velopack.json",
            ),
        ] {
            write_started(
                dir.path(),
                ELECTRON,
                Some("v2026-11-01"),
                installer,
                WRITTEN_AT,
            );
            assert_eq!(
                std::fs::read(path(dir.path())).unwrap(),
                fixture(name),
                "{name}"
            );
        }
        write_started(dir.path(), ELECTRON, Some(""), None, WRITTEN_AT);
        assert_eq!(
            std::fs::read(path(dir.path())).unwrap(),
            fixture("update-install-attempt.no-installer.json")
        );
    }

    #[test]
    fn no_marker_is_a_normal_launch_and_the_marker_is_read_once() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(detect(dir.path(), TAURI, || Velopack), None);
        write_started(
            dir.path(),
            TAURI,
            Some("v2026-11-02"),
            Some(Installer::Velopack),
            WRITTEN_AT,
        );
        assert_eq!(
            detect(dir.path(), TAURI, || Velopack).unwrap().outcome,
            DidNotApply
        );
        assert_eq!(detect(dir.path(), TAURI, || Velopack), None);
    }

    #[test]
    fn a_corrupt_marker_is_discarded_rather_than_guessed_at() {
        let dir = tempfile::tempdir().unwrap();
        for raw in [
            r#"{"fromVersion":"#,
            r#"{"fromVersion":""}"#,
            r#"{"toVersion":"x"}"#,
            "[]",
        ] {
            std::fs::write(path(dir.path()), raw).unwrap();
            assert_eq!(detect(dir.path(), TAURI, || Velopack), None, "{raw}");
            assert!(!path(dir.path()).exists(), "{raw}");
        }
    }

    #[test]
    fn reads_leniently_like_electron() {
        let attempt =
            parse(br#"{"fromVersion":"2026.806.2","startedAt":"","installer":"squirrel"}"#)
                .unwrap();
        assert_eq!(attempt.installer, None);
        assert_eq!(attempt.to_version, None);
        assert_eq!(attempt.duration_ms(WRITTEN_AT), None);
        let attempt =
            parse(br#"{"fromVersion":"2026.806.2","startedAt":7,"toVersion":3}"#).unwrap();
        assert_eq!(attempt.started_at, "");
        assert_eq!(attempt.to_version, None);
    }

    #[test]
    fn a_failed_write_never_reaches_the_caller() {
        let dir = tempfile::tempdir().unwrap();
        write_started(
            &dir.path().join("missing/dir"),
            TAURI,
            None,
            None,
            WRITTEN_AT,
        );
    }

    #[test]
    fn resolves_outcomes_by_the_electron_table() {
        let attempt = |installer| UpdateInstallAttempt {
            from_version: "2026.806.2".into(),
            to_version: None,
            started_at: String::new(),
            installer,
        };
        let handoff = Some(Installer::VelopackHandoff);
        let cases = [
            (attempt(handoff), "2026.806.2", Velopack, DidNotApply),
            (attempt(handoff), "2026.807.2", Velopack, HandoffApplied),
            (attempt(handoff), "2026.807.2", Nsis, HandoffFellBack),
            (attempt(handoff), "2026.807.2", Unknown, HandoffFellBack),
            (
                attempt(Some(Installer::ElectronUpdater)),
                "2026.807.2",
                Nsis,
                Applied,
            ),
            (
                attempt(Some(Installer::Velopack)),
                "2026.807.2",
                Velopack,
                Applied,
            ),
            (attempt(None), "2026.807.2", Velopack, Applied),
            (attempt(None), "2026.806.2", Unknown, DidNotApply),
        ];
        for (marker, current, layout, outcome) in cases {
            assert_eq!(
                resolve_outcome(&marker, current, || layout),
                outcome,
                "{marker:?} {current}"
            );
        }
    }
}
