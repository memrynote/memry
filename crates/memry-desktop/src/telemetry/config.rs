//! `telemetry.json` in the profile directory: install id, opt-out flags, last run version and
//! the diagnostics salt. Same keys and semantics as `apps/desktop/src/main/telemetry/config.ts`;
//! keys this build does not know survive every write.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

pub const FILE_NAME: &str = "telemetry.json";

pub struct TelemetryConfig {
    path: PathBuf,
}

impl TelemetryConfig {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    /// Everything on disk, or an empty map when the file is missing or unreadable.
    pub fn read(&self) -> Map<String, Value> {
        let Ok(raw) = fs::read_to_string(&self.path) else {
            return Map::new();
        };
        match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => map,
            _ => {
                tracing::warn!(
                    scope = "TelemetryConfig",
                    "telemetry config unreadable; returning empty"
                );
                Map::new()
            }
        }
    }

    /// Merges `updates` over what is on disk (read, merge, write to a sibling, rename).
    pub fn merge(&self, updates: Map<String, Value>) {
        let mut next = self.read();
        next.extend(updates);
        let write = || -> std::io::Result<()> {
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent)?;
            }
            let temp = self.path.with_extension("json.tmp");
            fs::write(
                &temp,
                serde_json::to_string_pretty(&Value::Object(next.clone()))?,
            )?;
            fs::rename(&temp, &self.path)
        };
        if let Err(error) = write() {
            tracing::error!(
                scope = "TelemetryConfig",
                "failed to persist telemetry config: {error}"
            );
        }
    }

    fn set(&self, key: &str, value: Value) {
        self.merge(Map::from_iter([(key.to_owned(), value)]));
    }

    pub fn enabled(&self) -> Option<bool> {
        self.read().get("enabled").and_then(Value::as_bool)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.set("enabled", Value::Bool(enabled));
    }

    /// Absent means on; only an explicit `false` opts out.
    pub fn auto_send_diagnostics(&self) -> bool {
        self.read()
            .get("autoSendDiagnostics")
            .and_then(Value::as_bool)
            != Some(false)
    }

    pub fn set_auto_send_diagnostics(&self, enabled: bool) {
        self.set("autoSendDiagnostics", Value::Bool(enabled));
    }

    pub fn last_run_version(&self) -> Option<String> {
        self.read()
            .get("lastRunVersion")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn set_last_run_version(&self, version: &str) {
        self.set("lastRunVersion", Value::String(version.to_owned()));
    }

    /// The install id, minted and stored on first use. An id that is not a UUID is replaced.
    pub fn install_id(&self) -> String {
        if let Some(id) = self.read().get("installId").and_then(Value::as_str)
            && uuid::Uuid::parse_str(id).is_ok()
        {
            return id.to_owned();
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.set("installId", Value::String(id.clone()));
        id
    }

    /// The salt of the diagnostics hasher: 32 lowercase hex characters, minted on first use.
    pub fn diagnostics_salt(&self) -> String {
        if let Some(salt) = self.read().get("diagnosticsSalt").and_then(Value::as_str)
            && salt.len() == 32
            && salt
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return salt.to_owned();
        }
        let salt = uuid::Uuid::new_v4().simple().to_string();
        self.set("diagnosticsSalt", Value::String(salt.clone()));
        salt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_without_auto_send_reports_it_on_and_unknown_keys_survive_a_write() {
        let dir = tempfile::tempdir().expect("tmp");
        fs::write(
            dir.path().join(FILE_NAME),
            r#"{"installId":"x","future":{"a":1}}"#,
        )
        .expect("seed");
        let config = TelemetryConfig::new(dir.path());
        assert!(config.auto_send_diagnostics());
        config.set_auto_send_diagnostics(false);
        assert!(!config.auto_send_diagnostics());
        config.set_enabled(true);
        let on_disk = config.read();
        assert_eq!(on_disk["future"], serde_json::json!({"a": 1}));
        assert_eq!(on_disk["enabled"], Value::Bool(true));
    }

    #[test]
    fn the_install_id_and_salt_are_minted_once_and_replaced_when_malformed() {
        let dir = tempfile::tempdir().expect("tmp");
        let config = TelemetryConfig::new(dir.path());
        let id = config.install_id();
        assert_eq!(config.install_id(), id);
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        let salt = config.diagnostics_salt();
        assert_eq!(salt.len(), 32);
        assert_eq!(config.diagnostics_salt(), salt);
        fs::write(
            dir.path().join(FILE_NAME),
            r#"{"installId":"not-a-uuid","diagnosticsSalt":"XYZ"}"#,
        )
        .expect("bad");
        assert_ne!(config.install_id(), "not-a-uuid");
        assert_eq!(config.diagnostics_salt().len(), 32);
    }

    #[test]
    fn a_damaged_file_reads_as_empty() {
        let dir = tempfile::tempdir().expect("tmp");
        fs::write(dir.path().join(FILE_NAME), "{oops").expect("bad");
        assert!(TelemetryConfig::new(dir.path()).read().is_empty());
    }
}
