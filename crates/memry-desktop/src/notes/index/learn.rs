//! A property the index reads with no definition gets one of the type it was first read with
//! (Electron's `learnCanonicalPropertyType`, #3530 13k-4c), and later values follow it: the
//! next pass retypes the rows that hold the name.
//!
//! Electron keeps the learned type as an unclocked data DB row. A full sync clocks it and
//! pushes it (`seedUnclocked`), and the next reload writes it into `properties.md`; a reload
//! before that drops it. So a device that does not sync (signed out, or holding no vault key)
//! learns no definition here either. A device that syncs writes it through
//! [`PropertyDefinitions`], file and record at once, and an offline one pushes it once online:
//! where Electron offline would drop it at the next open and learn it again at the next read.
//!
//! Not learned: a relation, which no definition holds (`isPersistableDefinitionType`), and a
//! pulled note's values, which reach its file with Step 17 and are read then.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::errors::SecureStoreError;
use memry_core::api::vault::Vault;
use memry_core::domain::property_values::{IndexedProperty, PROJECT_PROPERTY_KEY};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use serde_json::Value;

use crate::notes::property_definitions::{DefinitionType, PropertyDefinitions};

/// One pass's learning.
pub(super) struct Learner {
    root: PathBuf,
    vault: Arc<Vault>,
    store: Arc<dyn SecureStore>,
    /// Opened at the first property with no definition; `None` inside when it learns nothing.
    definitions: Option<Option<PropertyDefinitions>>,
    /// The names this pass tried: each is learned once.
    tried: BTreeSet<String>,
    /// A definition was learned: the rows holding it are owed its type.
    pub learned: bool,
}

impl Learner {
    pub fn new(root: PathBuf, vault: Arc<Vault>, store: Arc<dyn SecureStore>) -> Self {
        Self {
            root,
            vault,
            store,
            definitions: None,
            tried: BTreeSet::new(),
            learned: false,
        }
    }

    /// Learns the type of each of a note's `properties` that `types`, the definitions the pass
    /// reads by, has none for.
    pub fn learn(&mut self, properties: &[IndexedProperty], types: &HashMap<String, String>) {
        for property in properties {
            let Some(wanted) = learnable(property, types) else {
                continue;
            };
            if !self.tried.insert(property.name.clone()) {
                continue;
            }
            if self.definitions.is_none() {
                self.definitions = Some(self.open());
            }
            let Some(Some(definitions)) = &self.definitions else {
                return;
            };
            match definitions.learn(&property.name, wanted) {
                Ok(learned) => self.learned |= learned,
                Err(error) => tracing::warn!(
                    scope = "note_index",
                    name = property.name,
                    "a property's type was not learned: {error}"
                ),
            }
        }
    }

    fn open(&self) -> Option<PropertyDefinitions> {
        match syncs(self.store.as_ref()) {
            Ok(true) => {}
            Ok(false) => return None,
            Err(error) => {
                tracing::warn!(scope = "note_index", "no type learned: {error}");
                return None;
            }
        }
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

/// A device that syncs: an account signed in on it, holding the vault key.
fn syncs(store: &dyn SecureStore) -> Result<bool, SecureStoreError> {
    Ok(store.get(SecureStoreKey::RefreshToken)?.is_some()
        && store.get(SecureStoreKey::MasterKey)?.is_some())
}
