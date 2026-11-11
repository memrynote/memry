//! Typed access to the app-level preferences that other steps own but `memry-config.json` holds:
//! updater (Step 38), agent (Steps 22, 25, 28) and OCR languages (Step 25). Reads fall back to
//! the defaults Electron used (`store.ts`); every write edits only the key it names, so a key
//! this build does not know survives, inside these objects too.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::{AppConfig, ConfigError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdaterPrefs {
    pub skipped_version: Option<String>,
    pub auto_download: bool,
    /// On when absent: the app checks at launch unless the user turned it off.
    pub auto_check: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentPrefs {
    pub disclosure_accepted: bool,
    pub field_fill_disclosure_accepted: bool,
    pub access_mode: Option<String>,
    pub tool_approval_mode: Option<String>,
    /// Standing tool approvals, keyed by vault uuid so a grant never follows a vault switch.
    pub always_allowed_tools: BTreeMap<String, Vec<String>>,
    pub local_provider: Option<Map<String, Value>>,
}

fn object<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    map.get(key).and_then(Value::as_object)
}

fn flag(obj: Option<&Map<String, Value>>, key: &str, default: bool) -> bool {
    obj.and_then(|o| o.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn text(obj: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    obj.and_then(|o| o.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Sets `key` inside the object at `section`, creating the object when it is absent or not one.
fn set_in(map: &mut Map<String, Value>, section: &str, key: &str, value: Option<Value>) {
    let entry = map
        .entry(section.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    if let Some(obj) = entry.as_object_mut() {
        match value {
            Some(value) => obj.insert(key.to_owned(), value),
            None => obj.remove(key),
        };
    }
}

impl AppConfig {
    pub fn updater(&self) -> UpdaterPrefs {
        self.read(|map| {
            let updater = object(map, "updater");
            UpdaterPrefs {
                skipped_version: text(updater, "skippedVersion"),
                auto_download: flag(updater, "autoDownload", false),
                auto_check: flag(updater, "autoCheck", true),
            }
        })
    }

    pub fn set_updater_skipped_version(&self, version: Option<&str>) -> Result<(), ConfigError> {
        self.update(|map| {
            set_in(map, "updater", "skippedVersion", version.map(Value::from));
            Ok(())
        })
    }

    pub fn set_updater_auto_download(&self, on: bool) -> Result<(), ConfigError> {
        self.update(|map| {
            set_in(map, "updater", "autoDownload", Some(on.into()));
            Ok(())
        })
    }

    pub fn set_updater_auto_check(&self, on: bool) -> Result<(), ConfigError> {
        self.update(|map| {
            set_in(map, "updater", "autoCheck", Some(on.into()));
            Ok(())
        })
    }

    pub fn agent(&self) -> AgentPrefs {
        self.read(|map| {
            let agent = object(map, "agent");
            let tools = agent
                .and_then(|a| object(a, "alwaysAllowedTools"))
                .map(|tools| {
                    tools
                        .iter()
                        .map(|(vault, list)| {
                            let names = list
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect();
                            (vault.clone(), names)
                        })
                        .collect()
                })
                .unwrap_or_default();
            AgentPrefs {
                disclosure_accepted: flag(agent, "disclosureAccepted", false),
                field_fill_disclosure_accepted: flag(agent, "fieldFillDisclosureAccepted", false),
                access_mode: text(agent, "accessMode"),
                tool_approval_mode: text(agent, "toolApprovalMode"),
                always_allowed_tools: tools,
                local_provider: agent.and_then(|a| object(a, "localProvider")).cloned(),
            }
        })
    }

    /// Sets one top-level key of the agent preferences (`accessMode`, `toolApprovalMode`,
    /// `disclosureAccepted`, `localProvider`, ...); `None` removes it.
    pub fn set_agent_field(&self, key: &str, value: Option<Value>) -> Result<(), ConfigError> {
        self.update(|map| {
            set_in(map, "agent", key, value);
            Ok(())
        })
    }

    /// Replaces one vault's standing approvals and leaves every other vault's alone.
    pub fn set_always_allowed_tools(
        &self,
        vault_uuid: &str,
        tools: &[String],
    ) -> Result<(), ConfigError> {
        self.update(|map| {
            let mut all = map
                .get("agent")
                .and_then(|a| a.get("alwaysAllowedTools"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            all.insert(
                vault_uuid.to_owned(),
                tools.iter().cloned().map(Value::from).collect(),
            );
            set_in(map, "agent", "alwaysAllowedTools", Some(Value::Object(all)));
            Ok(())
        })
    }

    /// The OCR languages the user chose, `None` when the app language decides. Entries that are
    /// not strings are dropped; the caller validates the names.
    pub fn ocr_languages(&self) -> Option<Vec<String>> {
        self.read(|map| {
            map.get("ocrLanguages")?.as_array().map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
        })
    }

    pub fn set_ocr_languages(&self, languages: &[String]) -> Result<(), ConfigError> {
        self.update(|map| {
            map.insert(
                "ocrLanguages".to_owned(),
                languages.iter().cloned().map(Value::from).collect(),
            );
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(json: &str) -> (AppConfig, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("memry-config.json");
        std::fs::write(&path, json).expect("seed");
        (AppConfig::load(path), dir)
    }

    #[test]
    fn auto_check_is_on_when_absent_and_a_write_keeps_unknown_keys() {
        let (config, _dir) = config(r#"{"updater":{"futureKey":7},"other":1}"#);
        assert_eq!(
            config.updater(),
            UpdaterPrefs {
                skipped_version: None,
                auto_download: false,
                auto_check: true
            }
        );
        config.set_updater_auto_check(false).expect("write");
        config
            .set_updater_skipped_version(Some("1.2.3"))
            .expect("write");
        assert!(!config.updater().auto_check);
        assert_eq!(config.updater().skipped_version.as_deref(), Some("1.2.3"));
        config.set_updater_skipped_version(None).expect("clear");
        let kept = config.read(|m| (m["updater"]["futureKey"].clone(), m["other"].clone()));
        assert_eq!(kept, (Value::from(7), Value::from(1)));
    }

    #[test]
    fn standing_approvals_are_per_vault() {
        let (config, _dir) =
            config(r#"{"agent":{"accessMode":"vault_only","alwaysAllowedTools":{"work":["a"]}}}"#);
        config
            .set_always_allowed_tools("home", &["b".into(), "c".into()])
            .expect("write");
        let agent = config.agent();
        assert_eq!(agent.always_allowed_tools["work"], ["a"]);
        assert_eq!(agent.always_allowed_tools["home"], ["b", "c"]);
        assert_eq!(agent.access_mode.as_deref(), Some("vault_only"));
        assert!(!agent.disclosure_accepted);
        config
            .set_agent_field("disclosureAccepted", Some(true.into()))
            .expect("write");
        assert!(config.agent().disclosure_accepted);
    }

    #[test]
    fn ocr_languages_round_trip_and_absent_is_none() {
        let (config, _dir) = config("{}");
        assert_eq!(config.ocr_languages(), None);
        config
            .set_ocr_languages(&["eng".into(), "deu".into()])
            .expect("write");
        assert_eq!(
            config.ocr_languages(),
            Some(vec!["eng".to_owned(), "deu".to_owned()])
        );
    }
}
