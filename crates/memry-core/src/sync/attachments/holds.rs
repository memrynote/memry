//! Chunk holds, chapter 14 §14.8.1 (#3022), and the revived-note probe, §14.8.2 (#3054).
//!
//! `ref_count` counts uploads, so an item that shows chunks it did not upload holds them under
//! an opaque holder id before it pushes. The server keeps a chunk while `ref_count > 0` or a hold
//! names it, and answers `missing` for a holder whose chunks are already dead: that holder's bytes
//! must be uploaded again, never held again. Ports Electron's
//! `apps/desktop/src/main/canvas/assets/chunk-holds.ts`; the holder ids are pinned by
//! `packages/contracts/test-vectors/chunk-holds.json`.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

use crate::api::errors::{ApiError, CryptoError};
use crate::crypto::sodium;
use crate::protocol::http::{ApiRequest, Auth, HttpClient, RetryPolicy, VAULT_ID_HEADER};

/// Holder domain of a (canvas, image) pair, `chunk-holds.ts:19`.
pub const CANVAS_ASSET_DOMAIN: &str = "memry/canvas-asset-hold/v1";
/// Holder domain of a (note, attachment) probe, `chunk-holds.ts:20`.
pub const NOTE_PROBE_DOMAIN: &str = "memry/note-attachment-probe/v1";
/// The server's cap per request on holders, `ChunkHoldRequestSchema`.
pub const HOLDERS_PER_REQUEST: usize = 64;

/// One holder and the chunks (by encrypted hash) it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub holder_id: String,
    pub chunk_hashes: Vec<String>,
}

/// One attachment of a note, for [`probe_note_attachments`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentChunks {
    pub attachment_id: String,
    pub chunk_hashes: Vec<String>,
}

/// What a hold request came to (`HoldOutcome` in `chunk-holds.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HoldOutcome {
    /// Every holder not in `missing` is held. `missing` holds what the caller keyed the request
    /// by: holder ids for [`hold`], attachment ids for [`probe_note_attachments`].
    Held { missing: BTreeSet<String> },
    /// The server predates holds (404): nothing was held, and there is nothing to release.
    Unsupported,
    /// Offline, a server error, or a refusal. `retryable` is false for a 4xx other than 404, 408
    /// and 429, which fails the same way on every retry. `status` is 0 when no response came.
    Failed { retryable: bool, status: u16 },
}

/// BLAKE2b-256 keyed by the vault key over `domain NUL a NUL b`, lowercase hex
/// (`canvasAssetHolderId`, `chunk-holds.ts:49-56`). Every device derives the same id, so holding
/// and releasing from any of them is idempotent, and the server learns nothing about the item.
pub fn holder_id(vault_key: &[u8], domain: &str, a: &str, b: &str) -> Result<String, CryptoError> {
    let input = format!("{domain}\0{a}\0{b}");
    Ok(hex::encode(sodium::generichash(
        32,
        input.as_bytes(),
        Some(vault_key),
    )?))
}

/// The holder of one image a canvas shows, keyed by the image's content hash.
pub fn canvas_asset_holder_id(
    vault_key: &[u8],
    canvas_id: &str,
    content_hash: &str,
) -> Result<String, CryptoError> {
    holder_id(vault_key, CANVAS_ASSET_DOMAIN, canvas_id, content_hash)
}

/// Holds each holder's chunks, at most [`HOLDERS_PER_REQUEST`] holders per request, in the order
/// given. A holder id given twice is sent once, in its first place with the chunks of its last
/// entry, as Electron's `Map` does.
pub async fn hold(client: &HttpClient, vault_id: &str, holders: &[Holder]) -> HoldOutcome {
    let keyed = Keyed::from(holders.iter().map(|h| {
        let id = h.holder_id.clone();
        (id.clone(), id, h.chunk_hashes.clone())
    }));
    hold_keyed(client, vault_id, &keyed).await
}

/// Drops every hold of these holders, [`HOLDERS_PER_REQUEST`] per request. A replay drops
/// nothing, and a server that predates holds (404) has none, which is success.
pub async fn release(
    client: &HttpClient,
    vault_id: &str,
    holder_ids: &[String],
) -> Result<(), ApiError> {
    for window in holder_ids.chunks(HOLDERS_PER_REQUEST) {
        let body = serde_json::json!({ "holderIds": window });
        match client
            .send(request("/sync/attachments/holds/release", vault_id).json(&body))
            .await
        {
            Ok(_) => {}
            Err(error) if status_of(&error) == 404 => return Ok(()),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Which of a note's attachments have a chunk the server no longer keeps (§14.8.2,
/// `probeNoteAttachments`). Each attachment is held under a probe holder and released at once:
/// the hold route refuses a dead chunk, which `HEAD` and presign cannot tell from a live one.
/// `missing` names attachment ids. The release runs even after a failed hold, since an earlier
/// batch may have held; a lost release is undone by the next probe of the same pair.
pub async fn probe_note_attachments(
    client: &HttpClient,
    vault_id: &str,
    vault_key: &[u8],
    note_id: &str,
    attachments: &[AttachmentChunks],
) -> Result<HoldOutcome, CryptoError> {
    let mut entries = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let id = &attachment.attachment_id;
        let holder = holder_id(vault_key, NOTE_PROBE_DOMAIN, note_id, id)?;
        entries.push((holder, id.clone(), attachment.chunk_hashes.clone()));
    }
    let keyed = Keyed::from(entries.into_iter());
    if keyed.0.is_empty() {
        return Ok(HoldOutcome::Held {
            missing: BTreeSet::new(),
        });
    }
    let outcome = hold_keyed(client, vault_id, &keyed).await;
    if outcome == HoldOutcome::Unsupported {
        return Ok(outcome);
    }
    let holder_ids: Vec<String> = keyed.0.into_iter().map(|(id, ..)| id).collect();
    match release(client, vault_id, &holder_ids).await {
        Ok(()) => Ok(outcome),
        Err(_) if matches!(outcome, HoldOutcome::Failed { .. }) => Ok(outcome),
        Err(_) => Ok(HoldOutcome::Failed {
            retryable: true,
            status: 0,
        }),
    }
}

/// `(holder id, the key `missing` reports, chunk hashes)`: one entry per holder id in first-seen
/// order with the last entry's key and chunks, the iteration order of Electron's `Map`.
struct Keyed(Vec<(String, String, Vec<String>)>);

impl Keyed {
    fn from(entries: impl Iterator<Item = (String, String, Vec<String>)>) -> Self {
        let mut at: BTreeMap<String, usize> = BTreeMap::new();
        let mut ordered: Vec<(String, String, Vec<String>)> = Vec::new();
        for entry in entries {
            match at.get(&entry.0) {
                Some(&i) => ordered[i] = entry,
                None => {
                    at.insert(entry.0.clone(), ordered.len());
                    ordered.push(entry);
                }
            }
        }
        Self(ordered)
    }
}

/// `holdEach`.
async fn hold_keyed(client: &HttpClient, vault_id: &str, keyed: &Keyed) -> HoldOutcome {
    #[derive(Deserialize)]
    struct Answer {
        missing: Vec<String>,
    }
    let key_of: BTreeMap<&str, &str> = keyed
        .0
        .iter()
        .map(|(id, key, _)| (id.as_str(), key.as_str()))
        .collect();
    let mut missing = BTreeSet::new();
    for window in keyed.0.chunks(HOLDERS_PER_REQUEST) {
        let holds: Vec<serde_json::Value> = window
            .iter()
            .map(|(id, _, chunks)| serde_json::json!({ "holderId": id, "chunkHashes": chunks }))
            .collect();
        let body = serde_json::json!({ "holds": holds });
        let answer: Answer = match client
            .send_json(request("/sync/attachments/holds", vault_id).json(&body))
            .await
        {
            Ok(answer) => answer,
            Err(error) => return failure(&error),
        };
        let named = answer
            .missing
            .iter()
            .filter_map(|id| key_of.get(id.as_str()));
        missing.extend(named.map(|key| (*key).to_owned()));
    }
    HoldOutcome::Held { missing }
}

/// One attempt, as Electron's `fetch`: a hold that cannot finish waits for the next push cycle,
/// which is the retry. The 401 refresh still runs; it is not a retry.
fn request(path: &str, vault_id: &str) -> ApiRequest {
    ApiRequest::post(path)
        .auth(Auth::Session)
        .header(VAULT_ID_HEADER, vault_id)
        .retry(RetryPolicy::never())
}

fn failure(error: &ApiError) -> HoldOutcome {
    let status = status_of(error);
    if status == 404 {
        return HoldOutcome::Unsupported;
    }
    let retryable = status == 0 || status == 408 || status == 429 || status >= 500;
    HoldOutcome::Failed { retryable, status }
}

/// The HTTP status behind a failure, 0 when no response came (offline, unreadable body, no
/// local key), as `post` in `chunk-holds.ts` reports it.
fn status_of(error: &ApiError) -> u16 {
    match error {
        ApiError::Status { status, .. } => *status,
        ApiError::RateLimited { .. } => 429,
        ApiError::Unauthorized { .. } => 401,
        ApiError::DeviceRevoked { .. } => 401,
        ApiError::WritesDisabled { .. } => 403,
        ApiError::DeviceLimitReached { .. } => 409,
        ApiError::UpgradeRequired { .. } => 426,
        ApiError::PaymentRequired { .. } => 402,
        ApiError::BillingPortalUnavailable { .. } => 409,
        ApiError::BootstrapUnavailable => 501,
        ApiError::Transport { .. }
        | ApiError::Storage { .. }
        | ApiError::MalformedResponse { .. }
        | ApiError::InvalidClientIdentity { .. }
        | ApiError::NoMasterKey => 0,
    }
}
