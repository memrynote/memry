//! The types this device learned for properties that have no definition
//! ([`memry_core::domain::property_admin::learned`]): they type the property values the note
//! index and the property panels read, after every definition, and are no definition themselves.

use std::collections::{BTreeMap, HashMap};

use super::{DefinitionType, DefinitionsError, PropertyDefinitions};

impl PropertyDefinitions {
    /// `learnCanonicalPropertyType`: each of `wanted` (name to the type it was first read with)
    /// that has no definition, here or in the file, is learned on this device alone. A name the
    /// file holds in an entry this build cannot read (a newer build's type) has one. `true`
    /// when it learned one.
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
        if wanted.is_empty() {
            return Ok(false);
        }
        Ok(self.records.learn(&wanted)?)
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
