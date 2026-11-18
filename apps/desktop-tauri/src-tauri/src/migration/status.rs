//! What the migration view shows: one [`MigrationStatus`], in the user's language, built from a
//! progress update, a failure or the end of the run. `preboot.js` writes its strings into
//! `textContent` and does no lookup of its own.

use memry_desktop::electron_import::progress::{Phase, ProgressUpdate};
use memry_desktop::i18n::{self, Arg, Args};
use serde::{Deserialize, Serialize};

use super::MigrationFailure;

/// `idle` on a launch that migrates nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MigrationState {
    Idle,
    Running,
    Failed,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    /// Grows with every change, so the page drops an answer older than an update it was sent.
    pub seq: u32,
    pub state: MigrationState,
    /// 0 to 100.
    pub percent: u8,
    pub title: String,
    /// The phase line while running.
    pub phase: Option<String>,
    pub body: String,
    pub note: Option<String>,
    /// The failing check, as Step 37e2's `RunError::check` names it.
    pub check: Option<String>,
    /// The line that names `check` to the user.
    pub check_line: Option<String>,
    /// The error message, in English like the log.
    pub details: Option<String>,
}

impl MigrationStatus {
    fn new(state: MigrationState, percent: u8, title: String, body: String) -> Self {
        Self {
            seq: 0,
            state,
            percent,
            title,
            phase: None,
            body,
            note: None,
            check: None,
            check_line: None,
            details: None,
        }
    }
}

fn text(locale: &str, key: &str) -> String {
    i18n::t(locale, key, &Args::new())
}

fn count(value: u32) -> Arg {
    Arg::from(i64::from(value))
}

pub fn idle() -> MigrationStatus {
    MigrationStatus::new(MigrationState::Idle, 0, String::new(), String::new())
}

pub fn running(locale: &str, update: &ProgressUpdate) -> MigrationStatus {
    let phase = match update.phase {
        Phase::AppState => text(locale, "system:migration.phase.preparing"),
        Phase::Secrets => text(locale, "system:migration.phase.secrets"),
        Phase::Vault => i18n::t(
            locale,
            "system:migration.phase.vault",
            &Args::from([
                ("current".to_owned(), count(update.current)),
                ("total".to_owned(), count(update.total)),
            ]),
        ),
        Phase::Finish => text(locale, "system:migration.phase.checking"),
    };
    let mut status = MigrationStatus::new(
        MigrationState::Running,
        percent(update),
        text(locale, "system:migration.running.title"),
        text(locale, "system:migration.running.note"),
    );
    status.phase = Some(phase);
    status
}

/// The share of the run done when `update` arrives: 10% for the app state, 10% for the
/// secrets, 70% for the vaults and the rest for the checks. Never 100 before the end.
fn percent(update: &ProgressUpdate) -> u8 {
    let share = |done: u32, of: u32, span: u32| {
        if of == 0 { 0 } else { span * done.min(of) / of }
    };
    let value = match update.phase {
        Phase::AppState => share(update.current, update.total, 10),
        Phase::Secrets => 10 + share(update.current, update.total, 10),
        Phase::Vault => 20 + share(update.current.saturating_sub(1), update.total, 70),
        Phase::Finish => 90,
    };
    u8::try_from(value.min(99)).unwrap_or(99)
}

pub fn failed(locale: &str, failure: &MigrationFailure) -> MigrationStatus {
    let mut status = MigrationStatus::new(
        MigrationState::Failed,
        0,
        text(locale, "system:migration.failed.title"),
        text(locale, failure_body(&failure.check)),
    );
    status.note = Some(text(locale, "system:migration.failed.note"));
    status.check_line = Some(i18n::t(
        locale,
        "system:migration.failed.check",
        &Args::from([("check".to_owned(), Arg::from(failure.check.as_str()))]),
    ));
    status.check = Some(failure.check.clone());
    status.details = Some(failure.details.clone());
    status
}

/// The advice for a failing check. The names are `RunError::check` of Step 37e2; a check of
/// the verification report or an import error gets the general advice and its own name.
fn failure_body(check: &str) -> &'static str {
    match check {
        "electron-running" => "system:migration.failed.electronRunning",
        "disk-space" => "system:migration.failed.diskSpace",
        "electron-schema" => "system:migration.failed.electronSchema",
        "shared-store" => "system:migration.failed.sharedStore",
        "vault-unreachable" => "system:migration.failed.vaultUnreachable",
        check if check.starts_with("secrets:") => "system:migration.failed.secrets",
        _ => "system:migration.failed.verification",
    }
}

pub fn done(locale: &str) -> MigrationStatus {
    MigrationStatus::new(
        MigrationState::Done,
        100,
        text(locale, "system:migration.done.title"),
        text(locale, "system:migration.done.body"),
    )
}

/// The page's fixed copy: the button labels and the line for a missing report.
pub fn page_slots(locale: &str) -> Vec<(&'static str, String)> {
    vec![
        ("retry", text(locale, "system:migration.retry")),
        ("show-details", text(locale, "system:migration.showDetails")),
        (
            "report-missing",
            text(locale, "system:migration.reportMissing"),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(phase: Phase, current: u32, total: u32) -> ProgressUpdate {
        ProgressUpdate {
            phase,
            current,
            total,
            label: String::new(),
        }
    }

    #[test]
    fn the_bar_moves_forward_through_the_phases_and_stays_below_100_until_done() {
        let steps = [
            update(Phase::AppState, 0, 4),
            update(Phase::AppState, 4, 4),
            update(Phase::Secrets, 1, 1),
            update(Phase::Vault, 1, 3),
            update(Phase::Vault, 2, 3),
            update(Phase::Vault, 3, 3),
            update(Phase::Finish, 0, 0),
        ];
        let values: Vec<u8> = steps.iter().map(percent).collect();
        assert_eq!(values, [0, 10, 20, 20, 43, 66, 90]);
        assert_eq!(percent(&update(Phase::Vault, 9, 0)), 20);
        assert_eq!(done("en").percent, 100);
    }

    #[test]
    fn the_vault_phase_line_counts_vaults() {
        let status = running("en", &update(Phase::Vault, 2, 3));
        assert_eq!(status.phase.as_deref(), Some("Moving vault 2 of 3…"));
        assert_eq!(status.state, MigrationState::Running);
    }

    #[test]
    fn a_failure_names_its_check_and_keeps_the_message_as_details() {
        let failure = MigrationFailure {
            check: "secrets:unreadable".to_owned(),
            details: "the safe storage key is missing".to_owned(),
        };
        let status = failed("en", &failure);
        assert_eq!(status.check.as_deref(), Some("secrets:unreadable"));
        assert_eq!(
            status.check_line.as_deref(),
            Some("Failed check: secrets:unreadable")
        );
        assert_eq!(
            status.details.as_deref(),
            Some("the safe storage key is missing")
        );
        assert_eq!(
            status.body,
            text("en", "system:migration.failed.secrets"),
            "a secrets check gets the secrets advice"
        );
    }

    #[test]
    fn every_failing_check_has_advice_in_every_locale() {
        let checks = [
            "electron-running",
            "disk-space",
            "electron-schema",
            "shared-store",
            "vault-unreachable",
            "secrets:read",
            "check-3",
        ];
        for locale in memry_desktop::locale::SUPPORTED {
            for check in checks {
                let key = failure_body(check);
                assert_ne!(i18n::t(locale, key, &Args::new()), key, "{locale} {check}");
            }
        }
    }

    #[test]
    fn arabic_copy_is_arabic() {
        let status = running("ar", &update(Phase::Secrets, 0, 1));
        assert_ne!(
            status.title,
            running("en", &update(Phase::Secrets, 0, 1)).title
        );
    }
}
