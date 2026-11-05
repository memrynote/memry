//! A property the index reads with no definition gets one of the type it was first read with
//! (Electron's `learnCanonicalPropertyType`, #3530 13k-4c-2), and later values follow it: the
//! next pass retypes the rows that hold the name.
//!
//! Electron keeps the learned type as an unclocked data DB row, which types every later read
//! on the device, synced or not. A full sync clocks and pushes it (`seedUnclocked`), and the
//! first open after an update writes every such row into `properties.md`. Here it is written
//! through [`PropertyDefinitions`], file and record at once, on any device: a device signed out
//! pushes the record once it syncs, as Electron's seed pushes a row the file holds. Electron
//! drops a row it learned after that first open, unsynced, at the next open, and learns it
//! again at the next read of a note holding it; here it stays.
//!
//! **Which read is first.** Electron learns as its open walk reaches each file, in the walk's
//! directory order (`indexVault`, `findVaultFiles`). A pass here reads the smallest file
//! first, and a journal day is often the smallest: its `title: '2026-11-05'` would make every
//! note's `title` a date (the 13q-9 live-app diff). So a pass gathers the type each name is read
//! with and learns, at its end, the one of the first file by path: the walk's order, as a
//! directory listing sorted by name gives it.
//!
//! Not learned: a relation, which no definition holds (`isPersistableDefinitionType`); a name
//! whose definition this build cannot read ([`PropertyDefinitions::learn`]); and a pulled note's
//! values, which reach its file with Step 17 and are read then.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::vault::Vault;
use memry_core::domain::property_values::{IndexedProperty, PROJECT_PROPERTY_KEY};
use memry_core::seams::secure_store::SecureStore;
use serde_json::Value;

use crate::notes::property_definitions::{DefinitionType, PropertyDefinitions};

/// One pass's learning.
pub(super) struct Learner {
    root: PathBuf,
    vault: Arc<Vault>,
    store: Arc<dyn SecureStore>,
    /// Each name read with no definition: the path of the first file by path that holds it,
    /// and the type it was read with there.
    seen: BTreeMap<String, (String, DefinitionType)>,
}

impl Learner {
    pub fn new(root: PathBuf, vault: Arc<Vault>, store: Arc<dyn SecureStore>) -> Self {
        Self {
            root,
            vault,
            store,
            seen: BTreeMap::new(),
        }
    }

    /// Notes the type of each of the `properties` of the file at `path` that `types`, the
    /// definitions the pass reads by, has none for.
    pub fn read(
        &mut self,
        path: &str,
        properties: &[IndexedProperty],
        types: &HashMap<String, String>,
    ) {
        for property in properties {
            let Some(wanted) = learnable(property, types) else {
                continue;
            };
            let first = self
                .seen
                .get(&property.name)
                .is_none_or(|(held, _)| path < held.as_str());
            if first {
                self.seen
                    .insert(property.name.clone(), (path.to_owned(), wanted));
            }
        }
    }

    /// Learns each name read; `true` when it wrote a definition, whose rows are then owed its
    /// type.
    pub fn learn(self) -> bool {
        if self.seen.is_empty() {
            return false;
        }
        let Some(definitions) = self.open() else {
            return false;
        };
        let mut learned = false;
        for (name, (_, wanted)) in self.seen {
            match definitions.learn(&name, wanted) {
                Ok(wrote) => learned |= wrote,
                Err(error) => tracing::warn!(
                    scope = "note_index",
                    name,
                    "a property's type was not learned: {error}"
                ),
            }
        }
        learned
    }

    fn open(&self) -> Option<PropertyDefinitions> {
        match self.vault.property_definition_records(self.store.clone()) {
            Ok(records) => Some(PropertyDefinitions::new(self.root.clone(), records)),
            Err(error) => {
                tracing::warn!(scope = "note_index", "no type learned: {error}");
                None
            }
        }
    }
}

/// The type `property` gives a definition: none when one is there, but for a `project` one of
/// another type. A relation parses as no definition type.
fn learnable(
    property: &IndexedProperty,
    types: &HashMap<String, String>,
) -> Option<DefinitionType> {
    if let Some(held) = types.get(&property.name)
        && (property.name != PROJECT_PROPERTY_KEY || *held == property.type_name)
    {
        return None;
    }
    serde_json::from_value(Value::String(property.type_name.clone())).ok()
}
