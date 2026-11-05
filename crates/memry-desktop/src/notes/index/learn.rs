//! A property the index reads with no definition is typed, in every later read on this device,
//! by the type it was first read with (Electron's `learnCanonicalPropertyType`, #3530 13k-4c-2):
//! the next pass retypes the rows that hold the name.
//!
//! Electron keeps the learned type as a data DB row with no clock, which no file and no other
//! device holds; a full sync pushes it (`seedUnclocked`). Here it is a learned type in `data.db`
//! ([`PropertyDefinitions::learn`]), which no definitions list, `properties.md` or record holds.
//! Not here: making it a definition once the device syncs, as Electron's push does. A type the
//! user sets is a definition, and wins.
//!
//! **Which read is first.** A pass reads its notes in order ([`order`]): every note before
//! every journal day, each by path. A name is learned from its first read. So a day's
//! `title: '2026-11-05'` never types the notes' titles as dates (the 13q-9 live-app diff), and a
//! pass stopped or retried part way learns as the whole one would have. Electron learns as its
//! open walk reaches each file, in the order the platform lists a folder, so the two may pick a
//! different first file for a name.
//!
//! Not learned: a name with a definition (or whose definition was deleted, which stays deleted);
//! a relation, which no definition holds (`isPersistableDefinitionType`); `project`, whose type
//! its name decides; a name read only to retype it (Electron's `retypeIndexedProperties` learns
//! nothing); and a pulled note's values, which reach its file with Step 17 and are read then.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::vault::Vault;
use memry_core::domain::journal::valid_date;
use memry_core::domain::note_stats::Unindexed;
use memry_core::domain::property_values::{IndexedProperty, PROJECT_PROPERTY_KEY};
use memry_core::seams::secure_store::SecureStore;
use serde_json::Value;

use crate::notes::property_definitions::{DefinitionType, PropertyDefinitions};

/// One pass's learning.
pub(super) struct Learner {
    root: PathBuf,
    vault: Arc<Vault>,
    store: Arc<dyn SecureStore>,
    /// Each name read with no definition, and the type of its first read.
    seen: BTreeMap<String, DefinitionType>,
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

    /// Notes the type of each of a file's `properties` that `types`, the definitions the pass
    /// reads by, has none for, unless an earlier read gave it one.
    pub fn read(&mut self, properties: &[IndexedProperty], types: &HashMap<String, String>) {
        for property in properties {
            if let Some(wanted) = learnable(property, types) {
                self.seen.entry(property.name.clone()).or_insert(wanted);
            }
        }
    }

    /// Learns each name read, in one write; `true` when it learned one, whose rows are then
    /// owed its type.
    pub fn learn(self) -> bool {
        if self.seen.is_empty() {
            return false;
        }
        let Some(definitions) = self.open() else {
            return false;
        };
        definitions.learn(self.seen).unwrap_or_else(|error| {
            tracing::warn!(
                scope = "note_index",
                "no property type was learned: {error}"
            );
            false
        })
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

/// The type `property` was read with, when its name has none and its type is learned. A
/// relation parses as no definition type.
fn learnable(
    property: &IndexedProperty,
    types: &HashMap<String, String>,
) -> Option<DefinitionType> {
    if types.contains_key(&property.name) || property.name == PROJECT_PROPERTY_KEY {
        return None;
    }
    serde_json::from_value(Value::String(property.type_name.clone())).ok()
}

/// The order a pass reads `notes` in: every note before every journal day (`j<date>`), each by
/// path.
pub(super) fn order(notes: &mut [Unindexed]) {
    let day = |note: &Unindexed| {
        note.note_id
            .strip_prefix('j')
            .is_some_and(|date| valid_date(date).is_ok())
    };
    notes.sort_by(|a, b| (day(a), &a.path).cmp(&(day(b), &b.path)));
}
