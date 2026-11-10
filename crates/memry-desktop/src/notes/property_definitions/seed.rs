//! What a sync pass makes of this device's learned types (#4025): Electron's full sync seeds every
//! unclocked `property_definitions` row (`seedUnclocked`) between its pull and its push, so a type
//! a device learned becomes a definition every device shares once that device syncs.
//!
//! - Each learned type ([`super::learned`]) whose name has no record, live or deleted, and no
//!   entry in `properties.md`, a parsed one or one this build cannot parse, becomes a record
//!   ([`memry_core::domain::property_admin::learned::promote`]). A deleted definition stays deleted,
//!   whether it was deleted here or pulled.
//! - `project`, whose name decides its type, is not learned. While a note or a day carries it, its
//!   definition becomes a `project` one, as Electron's learner rewrites it (`name ===
//!   PROJECT_PROPERTY_KEY && existing.type !== type`) and its seed pushes it: a definition of
//!   another type keeps its default, color and, on the record, options; with none, one is made. A
//!   deleted record or an entry this build cannot parse is left as it is.
//! - Then the file takes the new records as it takes pulled ones ([`PropertyDefinitions::settle`]).
//!
//! The core's sync engine runs this ([`PassSeed`]) only after a pull that reached the feed head, so
//! a definition another device pushed first has landed and wins. It is idempotent: a promoted name
//! has a record, which is never promoted again.

use std::collections::BTreeSet;
use std::sync::{Arc, PoisonError};

use memry_core::api::errors::StorageError;
use memry_core::domain::property_values::PROJECT_PROPERTY_KEY;
use memry_core::sync::engine::PassSeed;

use super::{DefinitionsError, Next, PropertyDefinitions, TURN};
use crate::vault::consumer::rows::now_ms;
use crate::vault::properties_file::{self, PropertyDefinition, PropertyKind};

impl PropertyDefinitions {
    /// Promotes the learned types, makes `project` a `project` definition, and writes the new
    /// records into the file. Returns the promoted names. A file that cannot be read promotes
    /// nothing: which names it holds is unknown.
    pub fn seed(&self) -> Result<Vec<String>, DefinitionsError> {
        let promoted = {
            let _turn = TURN.lock().unwrap_or_else(PoisonError::into_inner);
            let file = properties_file::read(&self.vault)?;
            let held: BTreeSet<String> = file
                .definitions
                .iter()
                .map(|(name, _)| name.to_owned())
                .chain(file.unparsed_names().map(str::to_owned))
                .collect();
            self.records.promote(&held, now_ms())?
        };
        self.seed_project()?;
        self.settle()?;
        Ok(promoted)
    }

    fn seed_project(&self) -> Result<(), DefinitionsError> {
        if !self.records.in_use(PROJECT_PROPERTY_KEY)? {
            return Ok(());
        }
        self.change_renaming(PROJECT_PROPERTY_KEY, None, |existing, held| {
            let next = match existing {
                _ if held.unparsed || held.deleted => Next::Keep,
                Some(PropertyDefinition {
                    kind: PropertyKind::Project,
                    ..
                }) => Next::Keep,
                // A record of a type this build does not read.
                None if held.recorded => Next::Keep,
                existing => Next::Put(PropertyDefinition {
                    kind: PropertyKind::Project,
                    default_value: existing.as_ref().and_then(|e| e.default_value.clone()),
                    color: existing.and_then(|existing| existing.color),
                }),
            };
            Ok((next, ()))
        })
    }
}

/// [`PropertyDefinitions::seed`] as the sync engine's [`PassSeed`]. Step 17's driver registers it
/// with `SyncEngine::with_seed` for the open vault.
pub struct DefinitionsSeed(pub Arc<PropertyDefinitions>);

#[async_trait::async_trait]
impl PassSeed for DefinitionsSeed {
    async fn seed(&self) -> Result<(), StorageError> {
        let definitions = Arc::clone(&self.0);
        let seeded = tokio::task::spawn_blocking(move || definitions.seed())
            .await
            .map_err(|error| StorageError::Failed {
                what: format!("the property definitions seed did not finish: {error}"),
            })?;
        match seeded {
            Ok(promoted) if promoted.is_empty() => Ok(()),
            Ok(promoted) => {
                tracing::info!(
                    scope = "PropertyDefinitions",
                    count = promoted.len(),
                    "learned property types became definitions"
                );
                Ok(())
            }
            Err(error) => Err(StorageError::Failed {
                what: format!("the learned property types were not promoted: {error}"),
            }),
        }
    }
}
