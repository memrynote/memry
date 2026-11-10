//! What a sync pass makes of this device's file-only definitions (#4099) and learned types (#4025):
//! Electron's full sync seeds every unclocked `property_definitions` row (`seedUnclocked`) between
//! its pull and its push, so a definition only this device's `properties.md` holds (its rebuild,
//! `rebuildSingleDbCache`, gives such a row no clock) and a type a device learned become
//! definitions every device shares once that device syncs.
//!
//! - Each definition the file holds, parsed, whose name has no record, live, deleted or one this
//!   device cannot read, becomes a record of the file's definition, queued as a `create` like a definition the user creates
//!   (Electron's seed pushes `create` too), which the server re-creates over a purged deletion as
//!   it does Electron's (chapter 05 §5.12.3). The edit's turn first takes what the pull brought
//!   into the file: a record or a delete the server sent wins over a definition only the file
//!   holds (the core's `mirror`), as Electron's pull applies over a row with no clock and writes it
//!   into the file. A name whose record is deleted stays deleted: a hand edit that put it back
//!   after the file took the delete stays on this device until it is edited in the app. A name
//!   that fails is logged and left for the next pass; the rest are seeded.
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
//! a definition another device pushed first has landed and wins. It is idempotent: a seeded or
//! promoted name has a record, which is never seeded again.

use std::collections::BTreeSet;
use std::sync::{Arc, PoisonError};

use memry_core::api::errors::StorageError;
use memry_core::domain::property_values::PROJECT_PROPERTY_KEY;
use memry_core::sync::engine::PassSeed;

use super::{DefinitionsError, Next, PropertyDefinitions, TURN};
use crate::error::CoreError;
use crate::vault::consumer::rows::now_ms;
use crate::vault::properties_file::{self, PropertyDefinition, PropertyKind};

impl PropertyDefinitions {
    /// Makes a record of every definition only the file holds, promotes the learned types, makes
    /// `project` a `project` definition, and writes the new records into the file. Returns the
    /// names given a record, the file's first, in its order. A file that cannot be read seeds nothing: which
    /// names it holds is unknown.
    pub fn seed(&self) -> Result<Vec<String>, DefinitionsError> {
        let mut seeded = self.seed_file_only()?;
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
        seeded.extend(promoted);
        Ok(seeded)
    }

    /// The file's definitions whose names have no record in any state, each made a record in an
    /// edit's turn, which takes a pull into the file first. Returns the names given one.
    fn seed_file_only(&self) -> Result<Vec<String>, DefinitionsError> {
        let snapshot = self.records.snapshot()?;
        let unrecorded: Vec<String> = properties_file::read(&self.vault)?
            .definitions
            .iter()
            .map(|(name, _)| name.to_owned())
            .filter(|name| !snapshot.known(name))
            .collect();
        let mut seeded = Vec::new();
        for name in unrecorded {
            // The turn decides over a fresh snapshot: a pull that landed since this one wins.
            let put = self.change_renaming(&name, None, |existing, held| {
                Ok(match existing {
                    Some(definition) if !held.recorded && !held.deleted => {
                        (Next::Put(definition), true)
                    }
                    _ => (Next::Keep, false),
                })
            });
            match put {
                Ok(true) => seeded.push(name),
                Ok(false) => {}
                // The code only: the name and the message are the user's.
                Err(error) => tracing::warn!(
                    scope = "PropertyDefinitions",
                    code = error.kind_and_code().1,
                    "a definition only the file holds was not seeded; the next pass tries again"
                ),
            }
        }
        Ok(seeded)
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
            Ok(seeded) if seeded.is_empty() => Ok(()),
            Ok(seeded) => {
                tracing::info!(
                    scope = "PropertyDefinitions",
                    count = seeded.len(),
                    "file-only definitions and learned property types became definitions"
                );
                Ok(())
            }
            Err(error) => Err(StorageError::Failed {
                what: format!(
                    "the property definitions seed failed: {}",
                    error.kind_and_code().1
                ),
            }),
        }
    }
}
