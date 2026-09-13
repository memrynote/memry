//! The seal side of [`super::AccountCipher`], chapter 04 §4.2 – §4.8 and §4.11.
//!
//! [`AccountCipher`](super::AccountCipher) opens what the account's peers
//! wrote; this closes what this device writes. Both take the account's one
//! vault key (chapter 01 §1.7) and a device identity — the cipher takes the
//! directory of *other* devices' public keys, this takes *this* device's
//! secret key — so the two belong beside one another. They are separate files
//! for the reason [`crate::protocol::crdt_envelope`] is separate from
//! [`crate::protocol::envelope`]: the 600-line ceiling, and two halves that
//! share no code.
//!
//! **Nothing here is a second implementation of the envelope.** The bytes are
//! [`envelope::encrypt`]'s and [`crdt_envelope::pack`]'s, pinned by
//! `record-envelope.json` and `crdt-update.json`; this composes them, decides
//! *what* goes into the request, and refuses the cases that cannot be sealed.
//!
//! Four decisions carry the file, and three of them are the opposite of the
//! obvious guess.
//!
//! 1. **`stateVector` is never signed on a record push.** §4.6 forbids sending
//!    it; the server reconstructs the signature payload from the `clock` and
//!    `stateVector` *it received* (§4.10), so a client that signed one it did
//!    not send would earn `403 SYNC_INVALID_SIGNATURE` on every item. A
//!    `sync_items` row has no state-vector column, so the write path cannot
//!    reach one even by accident — and `record-envelope.json`'s one
//!    state-vector case pins the *general* writer, not this one.
//! 2. **The clock is rebound and stripped before it leaves.** §6.6: a clock
//!    containing `_offline` MUST never reach the server. Rebinding alone is
//!    not enough — it is a no-op at tick 0 (§6.6, `offline-clock.ts:41`), so a
//!    `{_offline: 0}` key survives it — and the key is therefore removed as
//!    well.
//! 3. **A record type that must carry a clock and has none is refused**, not
//!    sent clockless for the server to reject for ever (§5.4).
//! 4. **The signing key and `signerDeviceId` are one value.** §4.6 requires a
//!    client to derive the id from the same key material it signs with, in one
//!    step, because a verifier resolves the public key *by that id*: a
//!    signature that is valid but attributed to another device is accepted.
//!    [`DeviceSigner`] is that one step, and it is the only way to build a
//!    sealer.
//!
//! **The secret key is never logged, printed or serialised.**
//! [`DeviceSigner`]'s `Debug` prints the device id and the word `redacted`,
//! and the bytes are zeroed on drop.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use serde_json::Value as Json;
use zeroize::Zeroizing;

use crate::protocol::crdt_envelope::{self, CrdtMaterial, CrdtRequest};
use crate::protocol::envelope::{self, EnvelopeError, RecordMaterial, RecordRequest};
use crate::storage::repositories::sync_items::SyncItemRow;
use crate::sync::clock::{self, OFFLINE_CLOCK_DEVICE_ID, VectorClock};
use crate::sync::push::{PendingRecord, PushSealer};

/// An Ed25519 secret key as libsodium stores it: 32 seed bytes followed by the
/// 32-byte public key (`api::auth::signing_public_key`).
pub const SIGNING_SECRET_KEY_BYTES: usize = 64;

/// Chapter 07 §7.3: 5 MiB **decoded**, per individual update.
pub const MAX_UPDATE_BYTES: usize = 5 * 1024 * 1024;

/// Chapter 07 §7.4.1: `POST /sync/crdt/updates` caps each element at **twice**
/// [`MAX_UPDATE_BYTES`], because base64 inflates by four thirds and the cap is
/// applied to the encoded string rather than to the bytes it stands for.
pub const MAX_UPDATE_BASE64_BYTES: usize = 2 * MAX_UPDATE_BYTES;

/// Chapter 05 §5.4 and chapter 00 §0.7: `RECORD_CLOCK_REQUIRED_ITEM_TYPES` is
/// every record type except this one.
const CLOCK_EXEMPT_ITEM_TYPE: &str = "settings";

/// This device's signing identity: the key that produces `signature` and the
/// id a verifier resolves the matching public key by (§4.6).
///
/// One type rather than two arguments because §4.6 makes the pair
/// load-bearing: the verifier looks the public key up **by `signerDeviceId`**
/// (chapter 01 §1.4.0), so a client that filled the id from its session state
/// while signing with some other key would produce items that are valid and
/// attributed to the wrong device. Built once, from the keychain entry and the
/// token claim together, and passed around as a unit.
pub struct DeviceSigner {
    device_id: String,
    secret_key: Zeroizing<Vec<u8>>,
}

impl DeviceSigner {
    /// Fails rather than truncates: a keychain entry that is not 64 bytes is a
    /// profile problem, and finding that out at the first signature means
    /// finding it out as a `403` from the server.
    pub fn new(device_id: &str, signing_secret_key: Vec<u8>) -> Result<Self, EnvelopeError> {
        if signing_secret_key.len() != SIGNING_SECRET_KEY_BYTES {
            return Err(EnvelopeError::Malformed {
                what: format!(
                    "device signing key is {} bytes, not {SIGNING_SECRET_KEY_BYTES}",
                    signing_secret_key.len()
                ),
            });
        }
        if device_id.is_empty() {
            return Err(EnvelopeError::Malformed {
                what: "a signer with no device id cannot be resolved by a verifier".to_owned(),
            });
        }
        Ok(Self {
            device_id: device_id.to_owned(),
            secret_key: Zeroizing::new(signing_secret_key),
        })
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// The public key libsodium keeps in the tail of the secret key.
    ///
    /// The directory returned by `GET /auth/devices` answers the same bytes
    /// for [`Self::device_id`]; comparing the two is what makes §4.6's "one
    /// step" checkable rather than aspirational.
    pub fn signing_public_key(&self) -> &[u8] {
        &self.secret_key[32..SIGNING_SECRET_KEY_BYTES]
    }
}

/// Prints the id and nothing else. A signing key in a log is a compromised
/// device, and a `derive(Debug)` on a struct holding one is how it gets there.
impl fmt::Debug for DeviceSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceSigner")
            .field("device_id", &self.device_id)
            .field("secret_key", &"<redacted>")
            .finish()
    }
}

/// The entropy one seal consumes.
///
/// A seam for the same reason [`RecordMaterial`] is one (§4.3): production
/// draws fresh randomness per operation and the vector tier supplies the
/// committed values, because a vector cannot contain a random value and also
/// be reproducible. **The nonce is random per operation and is never a
/// counter.**
pub trait SealEntropy: Send + Sync {
    fn record(&self) -> RecordMaterial;
    fn crdt(&self) -> CrdtMaterial;
}

/// The production source: fresh key material for every item.
pub struct RandomEntropy;

impl SealEntropy for RandomEntropy {
    fn record(&self) -> RecordMaterial {
        RecordMaterial::random()
    }

    fn crdt(&self) -> CrdtMaterial {
        CrdtMaterial::random()
    }
}

/// Seals what a push wave sends, with the account's vault key and this
/// device's signing identity.
pub struct AccountSealer {
    vault_key: Zeroizing<Vec<u8>>,
    signer: DeviceSigner,
    entropy: Arc<dyn SealEntropy>,
}

impl AccountSealer {
    pub fn new(vault_key: Vec<u8>, signer: DeviceSigner) -> Self {
        Self::with_entropy(vault_key, signer, Arc::new(RandomEntropy))
    }

    /// The vector tier's constructor: the committed file key and nonces
    /// instead of fresh ones.
    pub fn with_entropy(
        vault_key: Vec<u8>,
        signer: DeviceSigner,
        entropy: Arc<dyn SealEntropy>,
    ) -> Self {
        Self {
            vault_key: Zeroizing::new(vault_key),
            signer,
            entropy,
        }
    }

    pub fn signer(&self) -> &DeviceSigner {
        &self.signer
    }
}

impl PushSealer for AccountSealer {
    /// One `POST /sync/push` item, chapter 04 §4.6 and §4.8.
    ///
    /// Every field comes from the row the wave read at send time (§6.5.2 P2)
    /// or from this device's identity. Nothing is carried from the outbox,
    /// which holds only the `(type, id)` key.
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        let row = &item.row;
        // A queued key whose row never got its payload cannot be rebuilt from
        // anything: §13.2 rule 1 says the bytes pushed are the bytes stored,
        // and there are none. Inventing an empty payload would publish an
        // empty item over a peer's good one.
        let Some(payload) = row.payload.as_deref() else {
            return Err(EnvelopeError::Malformed {
                what: format!(
                    "{}/{} is {} at send time and has no payload to push",
                    row.item_type, row.item_id, row.payload_state
                ),
            });
        };

        let sealed = envelope::encrypt(
            &RecordRequest {
                id: &row.item_id,
                item_type: &row.item_type,
                operation: item.operation,
                content: payload.as_bytes(),
                vault_key: &self.vault_key,
                signing_secret_key: &self.signer.secret_key,
                signer_device_id: &self.signer.device_id,
                clock: wire_clock(row, &self.signer.device_id)?,
                // Never, on this path. See the module header, rule 1.
                state_vector: None,
                deleted_at: row.deleted_at,
            },
            &self.entropy.record(),
        )?;

        Ok(envelope::to_record_push_json(&sealed.envelope))
    }

    /// One packed CRDT envelope, chapter 04 §4.11.
    ///
    /// The size gate is chapter 07 §7.4.1's, stated in the **base64 length**
    /// the request will carry rather than in the packed length, because that
    /// is the form the server measures.
    fn seal_crdt_update(&self, doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        let packed = crdt_envelope::pack(
            &CrdtRequest {
                note_id: doc_id,
                update,
                vault_key: &self.vault_key,
                signing_secret_key: &self.signer.secret_key,
            },
            &self.entropy.crdt(),
        )?;

        let encoded = base64_len(packed.len());
        if encoded > MAX_UPDATE_BASE64_BYTES {
            return Err(EnvelopeError::ItemTooLarge {
                bytes: encoded as u64,
                max_bytes: MAX_UPDATE_BASE64_BYTES as u64,
            });
        }
        Ok(packed)
    }
}

/// The `clock` this item goes out with, chapter 06 §6.6 and chapter 05 §5.4.
///
/// Read from the live row's column, which is the stored payload's own clock
/// (§A.1) — never from the outbox, which holds no payload by construction
/// (§6.5.2 P2).
fn wire_clock(row: &SyncItemRow, device_id: &str) -> Result<Option<VectorClock>, EnvelopeError> {
    let stored = match row.clock.as_deref() {
        None => None,
        Some(text) => {
            let parsed: VectorClock =
                serde_json::from_str(text).map_err(|error| EnvelopeError::Malformed {
                    what: format!(
                        "{}/{} has an unreadable clock: {error}",
                        row.item_type, row.item_id
                    ),
                })?;
            Some(parsed)
        }
    };

    let clock = stored.map(|clock| {
        // §6.6 in two steps, because one is not enough: rebinding moves the
        // ticks, and the removal covers the `{_offline: 0}` case rebinding
        // deliberately leaves alone.
        let mut rebound = clock::rebind_clock_device(&clock, device_id);
        rebound.remove(OFFLINE_CLOCK_DEVICE_ID);
        rebound
    });

    // An empty map is not the same wire value as an absent key (§4.6): it
    // changes the signed bytes. A clock that is empty after the rebind says
    // nothing, so the key is dropped rather than sent as `{}`.
    let clock = clock.filter(|clock: &BTreeMap<String, u64>| !clock.is_empty());

    if clock.is_none() && row.item_type != CLOCK_EXEMPT_ITEM_TYPE {
        return Err(EnvelopeError::Malformed {
            what: format!(
                "record type `{}` must carry a clock (chapter 05 §5.4) and {}'s live row has none",
                row.item_type, row.item_id
            ),
        });
    }
    Ok(clock)
}

/// The length of `n` bytes in standard base64 **with padding**, which is the
/// encoding chapter 04 §4.5 names and the form §7.4.1's cap is stated in.
fn base64_len(bytes: usize) -> usize {
    4 * bytes.div_ceil(3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::sodium;

    fn signer() -> DeviceSigner {
        let (_public, secret) = sodium::sign_seed_keypair(&[7u8; 32]).expect("a keypair");
        DeviceSigner::new("device-a", secret.to_vec()).expect("a signer")
    }

    fn row(item_type: &str, clock: Option<&str>) -> SyncItemRow {
        SyncItemRow {
            item_type: item_type.to_owned(),
            item_id: "item-1".to_owned(),
            payload: Some("{}".to_owned()),
            payload_state: "full".to_owned(),
            clock: clock.map(str::to_owned),
            field_clocks: None,
            server_cursor: None,
            signer_device_id: None,
            updated_at: 1,
            deleted_at: None,
            corrupt_reason: None,
            corrupt_at: None,
        }
    }

    #[test]
    fn a_signing_key_never_reaches_a_log() {
        let rendered = format!("{:?}", signer());
        assert!(rendered.contains("device-a"), "{rendered}");
        assert!(rendered.contains("redacted"), "{rendered}");
        // The seed is `07` repeated; the tail is the public key. Neither the
        // bytes nor any hex spelling of them may appear.
        assert!(!rendered.contains('7'), "{rendered}");
    }

    #[test]
    fn a_signing_key_that_is_not_sixty_four_bytes_is_refused_before_the_first_signature() {
        for length in [0, 32, 63, 65] {
            assert!(
                DeviceSigner::new("device-a", vec![0u8; length]).is_err(),
                "{length} bytes should not build a signer"
            );
        }
        assert!(DeviceSigner::new("", vec![0u8; 64]).is_err());
        assert!(DeviceSigner::new("device-a", vec![0u8; 64]).is_ok());
    }

    #[test]
    fn the_public_key_is_the_tail_of_the_secret_key() {
        let (public, secret) = sodium::sign_seed_keypair(&[7u8; 32]).expect("a keypair");
        let signer = DeviceSigner::new("device-a", secret.to_vec()).expect("a signer");
        assert_eq!(signer.signing_public_key(), public.as_slice());
    }

    #[test]
    fn a_row_with_no_payload_at_send_time_is_refused_rather_than_sent_empty() {
        // §13.2 rule 1: the bytes pushed are the bytes stored, and a
        // metadata-only row has none. An empty item would publish over a
        // peer's good one.
        let mut empty = row("task", Some(r#"{"device-a":1}"#));
        empty.payload = None;
        empty.payload_state = "metadata-only".to_owned();
        let sealer = AccountSealer::new(vec![3u8; 32], signer());
        let refused = sealer.seal_record(&PendingRecord {
            operation: envelope::SyncOperation::Update,
            row: empty,
        });
        assert!(
            matches!(&refused, Err(EnvelopeError::Malformed { what })
                if what.contains("metadata-only") && what.contains("no payload")),
            "{refused:?}"
        );
    }

    #[test]
    fn the_wire_clock_rebinds_and_then_removes_the_reserved_key() {
        // §6.6: the ticks move onto this device and are **added**, not maxed.
        let rebound = wire_clock(
            &row("task", Some(r#"{"_offline":2,"device-a":1}"#)),
            "device-a",
        )
        .expect("a clock")
        .expect("a clock");
        assert_eq!(rebound, clock::clock_of([("device-a", 3)]));

        // The case rebinding alone does not cover: at tick 0 it is a no-op and
        // the key survives, so the removal is a second step rather than a
        // consequence of the first.
        let zero = wire_clock(
            &row("task", Some(r#"{"_offline":0,"device-b":4}"#)),
            "device-a",
        )
        .expect("a clock")
        .expect("a clock");
        assert_eq!(zero, clock::clock_of([("device-b", 4)]));
        assert!(!zero.contains_key(OFFLINE_CLOCK_DEVICE_ID));
    }

    #[test]
    fn a_clock_that_is_empty_after_the_rebind_is_absent_and_not_an_empty_map() {
        // §4.6: `{}` and an absent key are different signed bytes, so the only
        // two answers are a non-empty clock or no key at all.
        assert_eq!(
            wire_clock(&row("settings", Some(r#"{"_offline":0}"#)), "device-a").expect("a clock"),
            None
        );
    }

    #[test]
    fn settings_is_the_only_record_type_that_may_go_out_without_a_clock() {
        assert_eq!(
            wire_clock(&row("settings", None), "device-a").expect("no clock"),
            None
        );
        for clocked in ["note", "task", "project", "journal"] {
            let refused = wire_clock(&row(clocked, None), "device-a");
            assert!(
                matches!(&refused, Err(EnvelopeError::Malformed { what }) if what.contains("§5.4")),
                "{clocked}: {refused:?}"
            );
        }
    }

    #[test]
    fn an_unreadable_clock_column_is_named_rather_than_silently_dropped() {
        let refused = wire_clock(&row("task", Some("not json")), "device-a");
        assert!(
            matches!(&refused, Err(EnvelopeError::Malformed { what }) if what.contains("item-1")),
            "{refused:?}"
        );
    }

    #[test]
    fn the_base64_length_is_the_padded_one_the_server_measures() {
        assert_eq!(base64_len(0), 0);
        assert_eq!(base64_len(1), 4);
        assert_eq!(base64_len(3), 4);
        assert_eq!(base64_len(4), 8);
        // The §7.4.1 boundary, without allocating ten mebibytes: the largest
        // packed run that still encodes inside the cap, and the first that
        // does not.
        let largest = MAX_UPDATE_BASE64_BYTES / 4 * 3;
        assert_eq!(base64_len(largest), MAX_UPDATE_BASE64_BYTES);
        assert!(base64_len(largest + 1) > MAX_UPDATE_BASE64_BYTES);
    }
}
