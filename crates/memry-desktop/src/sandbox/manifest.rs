//! The sandbox template's data: `seed.json` ([`Manifest`]) and `manifest.json`
//! ([`TemplateInfo`]), as `apps/cli/src/sandbox/export-template.ts` writes them.
//!
//! Rows are the generator's database rows by table, column names as in
//! `data.db` and `index.db`, with clocks, `synced_at`, `stored_at` and device
//! ids dropped: the replay takes those from the core it writes through.
//! Parsing fails closed: an unknown version, table or unsafe path is an error,
//! so a replay never drops data it does not understand.

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use super::SandboxError;

/// The only template version this build reads.
pub const MANIFEST_VERSION: u32 = 1;

/// Tables of `data.db` a template may carry rows for (the exporter's `DATA_TABLES`).
pub const DATA_TABLES: &[&str] = &[
    "settings",
    "property_definitions",
    "note_metadata",
    "tag_categories",
    "tag_definitions",
    "templates",
    "folder_configs",
    "projects",
    "statuses",
    "project_links",
    "tasks",
    "task_tags",
    "task_notes",
    "task_canvases",
    "task_activity",
    "calendar_events",
    "reminders",
    "inbox_items",
    "inbox_item_tags",
    "filing_history",
    "inbox_stats",
    "saved_filters",
    "bookmarks",
    "home_pages",
    "recently_opened",
    "vault_locks",
];

/// Tables of `index.db` a template may carry rows for (the exporter's `INDEX_TABLES`).
pub const INDEX_TABLES: &[&str] = &["note_snapshots"];

/// One database row: column name to SQLite value (text, integer, real or null).
pub type Row = serde_json::Map<String, serde_json::Value>;

/// A vault file that is a byte copy of a bundled asset, so the template stores it once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetCopy {
    /// Vault-relative path, `/`-separated.
    pub path: String,
    /// File name in the bundled `sandbox-assets` folder.
    pub asset: String,
    /// Lowercase hex sha256 of the asset bytes.
    pub sha256: String,
}

/// `seed.json`: what the generator left in the databases, plus the asset copies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    /// The generator's `now`, an RFC 3339 instant.
    pub generated_at: String,
    /// IANA name of the time zone the generator ran in; always `UTC`.
    pub timezone: String,
    pub assets: Vec<AssetCopy>,
    pub data: BTreeMap<String, Vec<Row>>,
    pub index: BTreeMap<String, Vec<Row>>,
}

impl Manifest {
    /// Parses and validates `seed.json`.
    pub fn parse(bytes: &[u8]) -> Result<Self, SandboxError> {
        let manifest: Self = serde_json::from_slice(bytes)?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), SandboxError> {
        check_header(self.version, &self.generated_at, &self.timezone)?;
        for (tables, known) in [(&self.data, DATA_TABLES), (&self.index, INDEX_TABLES)] {
            if let Some(table) = tables.keys().find(|table| !known.contains(&table.as_str())) {
                return Err(SandboxError::UnknownTable(table.clone()));
            }
        }
        for copy in &self.assets {
            check_relative_path(&copy.path)?;
            let plain_name = !copy.asset.is_empty()
                && !copy.asset.starts_with('.')
                && !copy.asset.contains(['/', '\\', ':']);
            let hex = copy.sha256.len() == 64
                && copy
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
            if !plain_name || !hex {
                return Err(SandboxError::BadAsset(copy.asset.clone()));
            }
        }
        Ok(())
    }

    /// The generator's `now`.
    pub fn generated_at(&self) -> DateTime<Utc> {
        parse_instant(&self.generated_at).expect("validated by Manifest::parse")
    }

    /// The template's "today": the generator's local date, which is UTC.
    pub fn template_date(&self) -> NaiveDate {
        self.generated_at().date_naive()
    }
}

/// `manifest.json`: the moment the template was exported and the generator's count table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateInfo {
    pub version: u32,
    pub generated_at: String,
    pub timezone: String,
    /// `generateSandbox`'s count table, in its print order.
    pub counts: serde_json::Map<String, serde_json::Value>,
}

impl TemplateInfo {
    pub fn parse(bytes: &[u8]) -> Result<Self, SandboxError> {
        let info: Self = serde_json::from_slice(bytes)?;
        check_header(info.version, &info.generated_at, &info.timezone)?;
        Ok(info)
    }

    /// The generator's count for `name` (`notes`, `journal entries`, ...).
    pub fn count(&self, name: &str) -> Option<u64> {
        self.counts.get(name).and_then(serde_json::Value::as_u64)
    }
}

fn check_header(version: u32, generated_at: &str, timezone: &str) -> Result<(), SandboxError> {
    if version != MANIFEST_VERSION {
        return Err(SandboxError::UnsupportedVersion(version));
    }
    if timezone != "UTC" {
        return Err(SandboxError::UnsupportedTimezone(timezone.to_owned()));
    }
    if parse_instant(generated_at).is_none() {
        return Err(SandboxError::BadGeneratedAt(generated_at.to_owned()));
    }
    Ok(())
}

fn parse_instant(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// A `/`-separated path that stays inside the vault on every platform.
pub fn check_relative_path(path: &str) -> Result<(), SandboxError> {
    let plain = !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '\0'])
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if plain {
        Ok(())
    } else {
        Err(SandboxError::UnsafePath(path.to_owned()))
    }
}
