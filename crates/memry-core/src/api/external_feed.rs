//! `ExternalFeed`: an edit made outside the app, fed into a note's body, for the
//! desktop vault tier (Step 12e). Reached from
//! [`crate::api::vault::Vault::external_feed`]. Not exported over UniFFI: iOS has
//! no vault files to edit from outside. The rules are in
//! [`crate::domain::external_feed`]. Every method blocks; the shell runs them in
//! `spawn_blocking`.

use std::sync::Arc;

use crate::api::errors::AuthError;
use crate::crdt::errors::CrdtError;
use crate::crypto::keys;
use crate::domain::external_feed::{self, FeedInput, FeedOutcome};
use crate::markdown::convert::api::Converter;
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;

pub struct ExternalFeed {
    db: Db,
    device_id: String,
}

impl ExternalFeed {
    /// Built by [`crate::api::vault::Vault::external_feed`]. A feed is a write
    /// authored by this device, so it needs the device identity, as
    /// [`crate::api::notes_write::NotesWriter`] does, and fails the same way
    /// rather than write under a borrowed one.
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let secret =
            store
                .get(SecureStoreKey::DeviceSigningKey)?
                .ok_or(AuthError::MalformedToken {
                    what: "this device has no signing key, so it has no identity to write under"
                        .to_string(),
                })?;
        let public = secret
            .get(32..64)
            .ok_or(AuthError::MalformedToken {
                what: "device signing key is not 64 bytes".to_string(),
            })?
            .to_vec();
        Ok(Self {
            db,
            device_id: keys::local_device_id_hex(&public)?,
        })
    }

    /// Makes `input.markdown` the body of the note. See
    /// [`crate::domain::external_feed`] for what each outcome means.
    pub fn feed(
        &self,
        converter: &Converter,
        input: FeedInput<'_>,
    ) -> Result<FeedOutcome, CrdtError> {
        self.run(external_feed::feed_external_edit, converter, input)
    }

    /// Gives the note the file's text when its body is empty, and leaves a body
    /// it has alone ([`FeedOutcome::BodyPresent`]).
    pub fn seed_body_if_empty(
        &self,
        converter: &Converter,
        input: FeedInput<'_>,
    ) -> Result<FeedOutcome, CrdtError> {
        self.run(external_feed::seed_body_if_empty, converter, input)
    }

    fn run(
        &self,
        step: fn(
            &rusqlite::Connection,
            &Converter,
            FeedInput<'_>,
            &str,
            i64,
        ) -> Result<FeedOutcome, CrdtError>,
        converter: &Converter,
        input: FeedInput<'_>,
    ) -> Result<FeedOutcome, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| Ok(step(conn, converter, input, &device_id, now_ms())))
            .map_err(CrdtError::from)?
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
