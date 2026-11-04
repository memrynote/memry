//! The journal charts' read (Step 13m-4b, #3530): each live day's property values in a range,
//! and every property any live day uses (`journal:getPropertyRows`, Electron's
//! `getJournalPropertyRows`).
//!
//! Electron reads the index of the day files' frontmatter. Here the values are the journal
//! records' ([`Journal::day_values`]), the owner sync writes, so a deleted day never counts and
//! a day with no file yet does. The day's own `date` key is left out: a row is on its day
//! already. A property's type is its definition's, else the type most of its values read as
//! ([`property_type`]), the alphabetically first of a tie.

use std::collections::{BTreeMap, HashMap};

use memry_core::domain::journal::valid_date;
use memry_core::domain::property_values::property_type;
use memry_core::markdown::frontmatter::json_to_yaml;
use serde::Serialize;
use serde_json::{Map, Value};

use super::{SCOPE, day_path};
use crate::notes::error::NotesError;
use crate::notes::service::NotesService;
use crate::session::OpenVault;

/// `JournalPropertyRow`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalPropertyRowView {
    pub id: String,
    pub date: String,
    /// The day's file, or where it goes when it has none yet.
    pub path: String,
    /// A day is titled by its date, as Electron's index titles its file.
    pub title: String,
    pub properties: Map<String, Value>,
}

/// `JournalPropertySummary`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalPropertySummaryView {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub count: u32,
}

/// `GetPropertyRowsOutput`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyRowsView {
    /// The days in range, oldest first.
    pub rows: Vec<JournalPropertyRowView>,
    /// Every property of any live day, not only the ones in range: most used first.
    pub properties: Vec<JournalPropertySummaryView>,
}

impl NotesService {
    /// The live days in `from..=to` with their property values, and every property in use.
    pub fn journal_property_rows(
        &self,
        open: &OpenVault,
        from: &str,
        to: &str,
    ) -> Result<PropertyRowsView, NotesError> {
        let (from, to) = (valid_date(from)?, valid_date(to)?);
        let days = self.journal(open)?.day_values()?;
        let defined = self.definition_types(open);

        // name -> type -> values of that type.
        let mut used: BTreeMap<&str, BTreeMap<String, u32>> = BTreeMap::new();
        for day in &days {
            for (name, value) in &day.values {
                let type_name = property_type(name, &json_to_yaml(value), None);
                *used.entry(name).or_default().entry(type_name).or_default() += 1;
            }
        }
        let mut properties: Vec<JournalPropertySummaryView> = used
            .into_iter()
            .map(|(name, types)| summary(name, &types, &defined))
            .collect();
        // A tie by name, case folded: Electron's `localeCompare` orders by the user's locale
        // and differs only for names outside ASCII letters, as `é` beside `e`.
        properties.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        let rows = days
            .into_iter()
            .filter(|day| (from..=to).contains(&day.date.as_str()))
            .map(|day| JournalPropertyRowView {
                path: match day.path {
                    Some(path) => path,
                    None => planned_path(open, &day.date),
                },
                title: day.date.clone(),
                properties: day.values,
                date: day.date,
                id: day.id,
            })
            .collect();
        Ok(PropertyRowsView { rows, properties })
    }
}

/// Where the file of a day with none yet goes; empty, and logged, for a record whose date is not
/// `YYYY-MM-DD` (one a build that checks less may have pushed).
fn planned_path(open: &OpenVault, date: &str) -> String {
    day_path(&open.path, date).unwrap_or_else(|error| {
        tracing::warn!(
            scope = SCOPE,
            date,
            "a chart row's day has no path: {error}"
        );
        String::new()
    })
}

/// One property's line: how many values it has, and its type.
fn summary(
    name: &str,
    types: &BTreeMap<String, u32>,
    defined: &HashMap<String, String>,
) -> JournalPropertySummaryView {
    let mut most: Option<(&String, u32)> = None;
    for (type_name, &count) in types {
        if most.is_none_or(|(_, seen)| count > seen) {
            most = Some((type_name, count));
        }
    }
    let inferred = most
        .map(|(type_name, _)| type_name.clone())
        .unwrap_or_default();
    JournalPropertySummaryView {
        name: name.to_owned(),
        type_name: defined.get(name).cloned().unwrap_or(inferred),
        count: types.values().sum(),
    }
}
