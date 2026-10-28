//! The install-failure streak across launches (`apps/desktop/src/main/updater-install-health.ts`,
//! #1999). A failed install surfaces in a session that then quits normally, so only a file
//! carries the streak to the next launch. The file is a contract with Electron: same name, same
//! keys, same compact JSON. A missing or corrupt file means no streak and never fails the
//! caller.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

pub const UPDATE_INSTALL_HEALTH_FILENAME: &str = "update-install-health.json";

/// Failed attempts before the user is offered the manual installer.
pub const STUCK_INSTALL_FAILURES: u32 = 3;
/// Far past the threshold; only stops a garbage value from growing without bound.
pub const MAX_RECORDED_FAILURES: u32 = 999;

/// Guards versions read back from disk before they reach the state and the dialog. A value
/// that does not match is refused whole, never sanitised into a plausible version.
pub static VERSION_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$").expect("static pattern"));

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallHealth {
    /// Display version of the build that keeps failing to update. Booting as anything else
    /// means the app moved on.
    pub from_version: String,
    /// Display version being installed. The streak is per target.
    pub target_version: String,
    pub consecutive_failures: u32,
    /// Latched once the streak escalated, so the dialog fires once per streak.
    pub escalated: bool,
}

fn path(dir: &Path) -> PathBuf {
    dir.join(UPDATE_INSTALL_HEALTH_FILENAME)
}

fn version(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| VERSION_TOKEN.is_match(text))
        .map(str::to_owned)
}

/// `Number.isInteger` in range: `3.0` counts, `3.5` and `1e300` do not.
fn failure_count(value: &Value) -> Option<u32> {
    let number = value.as_f64()?;
    let in_range =
        number.fract() == 0.0 && (1.0..=f64::from(MAX_RECORDED_FAILURES)).contains(&number);
    in_range.then_some(number as u32)
}

pub fn parse(raw: &[u8]) -> Option<UpdateInstallHealth> {
    let value: Value = serde_json::from_slice(raw).ok()?;
    Some(UpdateInstallHealth {
        from_version: version(value.get("fromVersion")?)?,
        target_version: version(value.get("targetVersion")?)?,
        consecutive_failures: failure_count(value.get("consecutiveFailures")?)?,
        escalated: value.get("escalated")?.as_bool()?,
    })
}

fn read(dir: &Path) -> Option<UpdateInstallHealth> {
    parse(&super::read_marker(&path(dir))?)
}

fn write(dir: &Path, health: &UpdateInstallHealth) {
    let result = serde_json::to_vec(health)
        .map_err(std::io::Error::other)
        .and_then(|bytes| std::fs::write(path(dir), bytes));
    if let Err(error) = result {
        tracing::warn!(
            scope = "UpdateInstallHealth",
            "failed to persist the update-install streak; it restarts next launch: {error}"
        );
    }
}

fn clear(dir: &Path) {
    match std::fs::remove_file(path(dir)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(
            scope = "UpdateInstallHealth",
            "failed to clear the update-install streak: {error}"
        ),
    }
}

/// Counts one failed install of `target` from `from` (display versions). Returns the streak and
/// whether this attempt crossed the threshold, which happens once per streak. A different
/// `from` or `target` starts a new streak.
pub fn record_failure(dir: &Path, from: &str, target: &str) -> (u32, bool) {
    let previous =
        read(dir).filter(|health| health.from_version == from && health.target_version == target);
    let consecutive_failures = previous
        .as_ref()
        .map_or(1, |health| health.consecutive_failures + 1)
        .min(MAX_RECORDED_FAILURES);
    let was_escalated = previous.is_some_and(|health| health.escalated);
    let stuck = !was_escalated && consecutive_failures >= STUCK_INSTALL_FAILURES;
    write(
        dir,
        &UpdateInstallHealth {
            from_version: from.to_owned(),
            target_version: target.to_owned(),
            consecutive_failures,
            escalated: was_escalated || stuck,
        },
    );
    (consecutive_failures, stuck)
}

/// Once per launch, before any install attempt. Booting as another build than the streak's
/// `fromVersion` is the evidence an install applied, so the file goes. An escalated streak on
/// the same build returns its target, so the manual-installer dialog comes back on every launch
/// the user is still stranded.
pub fn reconcile(dir: &Path, current: &str) -> Option<String> {
    let health = read(dir)?;
    if health.from_version != current {
        clear(dir);
        return None;
    }
    health.escalated.then_some(health.target_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The production shapes from #1999.
    const STUCK_BUILD: &str = "v2026-08-17.1";
    const TARGET: &str = "v2026-09-03.2";

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_raw(dir: &Path, contents: &str) {
        std::fs::write(path(dir), contents).unwrap();
    }

    #[test]
    fn escalates_on_the_third_failed_install_of_the_same_update_and_only_once() {
        let d = dir();
        assert_eq!(record_failure(d.path(), STUCK_BUILD, TARGET), (1, false));
        assert_eq!(record_failure(d.path(), STUCK_BUILD, TARGET), (2, false));
        assert_eq!(record_failure(d.path(), STUCK_BUILD, TARGET), (3, true));
        assert_eq!(record_failure(d.path(), STUCK_BUILD, TARGET), (4, false));
    }

    #[test]
    fn keeps_the_streak_across_launches() {
        let d = dir();
        record_failure(d.path(), STUCK_BUILD, TARGET);
        record_failure(d.path(), STUCK_BUILD, TARGET);
        assert_eq!(reconcile(d.path(), STUCK_BUILD), None);
        assert_eq!(record_failure(d.path(), STUCK_BUILD, TARGET), (3, true));
    }

    #[test]
    fn restarts_the_streak_when_a_new_update_is_the_one_failing() {
        let d = dir();
        for _ in 0..3 {
            record_failure(d.path(), STUCK_BUILD, TARGET);
        }
        assert_eq!(
            record_failure(d.path(), STUCK_BUILD, "v2026-09-10.1"),
            (1, false)
        );
        assert_eq!(reconcile(d.path(), STUCK_BUILD), None);
    }

    #[test]
    fn re_surfaces_an_escalated_streak_on_every_launch_the_app_is_still_stuck() {
        let d = dir();
        for _ in 0..3 {
            record_failure(d.path(), STUCK_BUILD, TARGET);
        }
        assert_eq!(reconcile(d.path(), STUCK_BUILD).as_deref(), Some(TARGET));
        assert_eq!(reconcile(d.path(), STUCK_BUILD).as_deref(), Some(TARGET));
    }

    #[test]
    fn clears_everything_once_the_app_boots_as_a_different_build() {
        let d = dir();
        for _ in 0..3 {
            record_failure(d.path(), STUCK_BUILD, TARGET);
        }
        assert_eq!(reconcile(d.path(), TARGET), None);
        assert!(!path(d.path()).exists());
        assert_eq!(
            record_failure(d.path(), TARGET, "v2026-09-10.1"),
            (1, false)
        );
    }

    #[test]
    fn behaves_like_a_fresh_install_when_no_file_exists() {
        let d = dir();
        assert_eq!(reconcile(d.path(), STUCK_BUILD), None);
        assert_eq!(record_failure(d.path(), STUCK_BUILD, TARGET), (1, false));
    }

    #[test]
    fn degrades_to_no_streak_on_a_torn_file() {
        let d = dir();
        write_raw(d.path(), r#"{"fromVersion":"v2026-08-17.1","targetVer"#);
        assert_eq!(reconcile(d.path(), STUCK_BUILD), None);
        assert_eq!(record_failure(d.path(), STUCK_BUILD, TARGET), (1, false));
    }

    #[test]
    fn refuses_a_hostile_target_version_instead_of_sanitising_it() {
        let d = dir();
        write_raw(
            d.path(),
            r#"{"fromVersion":"v2026-08-17.1","targetVersion":"/Users/kaan/x","consecutiveFailures":3,"escalated":true}"#,
        );
        assert_eq!(reconcile(d.path(), STUCK_BUILD), None);
    }

    #[test]
    fn refuses_an_out_of_range_or_fractional_count() {
        let d = dir();
        for count in ["9007199254740991", "0", "2.5", "1000"] {
            write_raw(
                d.path(),
                &format!(
                    r#"{{"fromVersion":"{STUCK_BUILD}","targetVersion":"{TARGET}","consecutiveFailures":{count},"escalated":false}}"#
                ),
            );
            assert_eq!(
                record_failure(d.path(), STUCK_BUILD, TARGET),
                (1, false),
                "{count}"
            );
        }
        assert!(parse(br#"{"fromVersion":"a","targetVersion":"b","consecutiveFailures":3.0,"escalated":false}"#).is_some());
    }

    #[test]
    fn refuses_a_non_boolean_latch() {
        let d = dir();
        write_raw(
            d.path(),
            &format!(
                r#"{{"fromVersion":"{STUCK_BUILD}","targetVersion":"{TARGET}","consecutiveFailures":3,"escalated":"yes"}}"#
            ),
        );
        assert_eq!(reconcile(d.path(), STUCK_BUILD), None);
    }

    #[test]
    fn a_failed_write_never_reaches_the_caller() {
        let d = dir();
        let missing = d.path().join("does/not/exist");
        assert_eq!(record_failure(&missing, STUCK_BUILD, TARGET), (1, false));
    }

    #[test]
    fn reads_and_writes_the_files_electron_writes() {
        let one =
            include_bytes!("../../tests/fixtures/electron/updater/update-install-health.1.json");
        let escalated = include_bytes!(
            "../../tests/fixtures/electron/updater/update-install-health.escalated.json"
        );

        // Electron's streak continues here: two more failures escalate it.
        let d = dir();
        std::fs::write(path(d.path()), one).unwrap();
        assert_eq!(
            record_failure(d.path(), "v2026-10-15", "v2026-11-01"),
            (2, false)
        );
        assert_eq!(
            record_failure(d.path(), "v2026-10-15", "v2026-11-01"),
            (3, true)
        );
        // The file this code wrote is byte for byte the one Electron writes.
        assert_eq!(std::fs::read(path(d.path())).unwrap(), escalated);

        // An escalated Electron file surfaces its target on the same build and clears on the
        // first launch of another one (the Tauri build after the update).
        std::fs::write(path(d.path()), escalated).unwrap();
        assert_eq!(
            reconcile(d.path(), "v2026-10-15").as_deref(),
            Some("v2026-11-01")
        );
        assert_eq!(reconcile(d.path(), "v2026-11-01"), None);
        assert!(!path(d.path()).exists());
    }
}
