//! The types this device learned for properties that have no definition
//! ([`memry_core::domain::property_admin::learned`]): they type the property values the note
//! index and the property panels read, after every definition, until [`PropertyDefinitions::fold_learned`]
//! writes them into `properties.md`, where they are definitions like any other.

use std::collections::{BTreeMap, HashMap};
use std::sync::PoisonError;

use serde_json::Value;

use super::kind::kind_of;
use super::{DefinitionType, DefinitionsError, PropertyDefinitions, TURN};
use crate::error::CoreError;
use crate::vault::properties_file::{self, PropertyDefinition};

impl PropertyDefinitions {
    /// `learnCanonicalPropertyType`: each of `wanted` (name to the type it was read with) that
    /// has no definition, here or in the file, is learned, then written into the file
    /// ([`Self::fold_learned`]). A name the file holds in an entry this build cannot read (a
    /// newer build's type) has one. `true` when it learned one.
    pub fn learn(
        &self,
        wanted: BTreeMap<String, DefinitionType>,
    ) -> Result<bool, DefinitionsError> {
        let file = self.file();
        let defined = |name: &str| {
            file.as_ref().is_some_and(|file| {
                file.definitions.get(name).is_some()
                    || file.unparsed_names().any(|held| held == name)
            })
        };
        let wanted: BTreeMap<String, String> = wanted
            .into_iter()
            .filter(|(name, _)| !defined(name))
            .filter_map(|(name, wanted)| Some((name, type_text(wanted)?)))
            .collect();
        if wanted.is_empty() || !self.records.learn(&wanted)? {
            return Ok(false);
        }
        self.fold_learned_or_warn();
        Ok(true)
    }

    /// [`Self::fold_learned`], a failure logged: the learned types still type every read, and
    /// the next list or learn tries again.
    pub(super) fn fold_learned_or_warn(&self) {
        if let Err(error) = self.fold_learned() {
            tracing::warn!(
                scope = "PropertyDefinitions",
                code = error.kind_and_code().1,
                "learned property types are not in the file yet"
            );
        }
    }

    /// Writes each learned type into `properties.md` as a definition of that type, as
    /// Electron's reload and its local definition writes fold the index's learned rows into the
    /// file (2b3a512960): a vault opened from Obsidian keeps its text and number definitions,
    /// and Settings lists them. A name the file already holds, in an entry this build cannot
    /// parse too, keeps the file's entry. Each name the file holds then leaves the learned types.
    /// No record is written: the next sync pass seeds the file's new definitions
    /// ([`Self::seed`]), as Electron's `seedUnclocked` pushes its rows. Returns the names
    /// written.
    pub fn fold_learned(&self) -> Result<Vec<String>, DefinitionsError> {
        let _turn = TURN.lock().unwrap_or_else(PoisonError::into_inner);
        let learned = self.records.learned()?;
        if learned.is_empty() {
            return Ok(Vec::new());
        }
        let (added, held) = properties_file::update_file(&self.vault, |file| {
            let mut added = Vec::new();
            let mut held = Vec::new();
            for (name, type_name) in learned {
                let in_file = file.definitions.get(&name).is_some()
                    || file.unparsed_names().any(|unparsed| unparsed == name);
                if !in_file {
                    let Ok(wanted) = serde_json::from_value(Value::String(type_name)) else {
                        continue;
                    };
                    let definition = PropertyDefinition {
                        kind: kind_of(wanted, None, None),
                        default_value: None,
                        color: None,
                    };
                    file.definitions.insert(name.clone(), definition);
                    added.push(name.clone());
                }
                held.push(name);
            }
            (added, held)
        })?;
        self.records.forget_learned(&held)?;
        Ok(added)
    }

    /// Each property's type by name: the definitions', then the learned ones'.
    pub fn types(&self) -> Result<HashMap<String, String>, DefinitionsError> {
        let mut types: HashMap<String, String> = self
            .list()?
            .into_iter()
            .filter_map(|definition| Some((definition.name, type_text(definition.type_name)?)))
            .collect();
        let unread: Vec<String> = self
            .file()
            .map(|file| file.unparsed_names().map(str::to_owned).collect())
            .unwrap_or_default();
        for (name, type_name) in self.records.learned()? {
            if !unread.contains(&name) {
                types.entry(name).or_insert(type_name);
            }
        }
        Ok(types)
    }
}

fn type_text(type_name: DefinitionType) -> Option<String> {
    let value = serde_json::to_value(type_name).ok()?;
    Some(value.as_str()?.to_owned())
}
