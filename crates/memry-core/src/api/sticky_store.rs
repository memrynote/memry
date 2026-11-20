//! `StickyStore`: desktop's sticky drafts (`apps/desktop/src/main/stickies/drafts.ts`) over the
//! `sticky_draft` record ([`crate::domain::sticky_draft`]), which owns the writes, the no-op save
//! and the new-id rule. This adds the content limit of `StickySaveDraftSchema`
//! (`packages/contracts/src/sticky-api.ts`) and the ISO instants the renderer reads. Desktop
//! only: not part of the FFI surface.

use crate::api::errors::StorageError;
use crate::domain::notes::iso;
use crate::domain::sticky_draft::{self, StickyKind};
use crate::storage::Db;

/// `StickySaveDraftSchema`'s `content.max(100_000)`, in UTF-16 code units as zod counts.
pub const MAX_CONTENT_UNITS: usize = 100_000;

/// One live draft as the renderer's `StickyDraft` holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StickyDraft {
    pub id: String,
    pub content: String,
    /// `note`, `task` or `journal`: a kind this build does not know reads as `note`.
    pub kind: String,
    /// ISO 8601 with milliseconds.
    pub created_at: String,
    pub modified_at: String,
}

/// The drafts of one opened vault, written under this device's identity.
pub struct StickyStore {
    data: Db,
    device_id: String,
}

impl StickyStore {
    /// Built by [`crate::api::vault::Vault::sticky_store`].
    pub(crate) fn over(data: Db, device_id: String) -> Self {
        Self { data, device_id }
    }

    /// Every live draft, most recently edited first.
    pub fn list(&self) -> Result<Vec<StickyDraft>, StorageError> {
        self.data.call_blocking(|conn| {
            sticky_draft::list(conn)?
                .into_iter()
                .map(StickyDraft::try_from)
                .collect()
        })
    }

    /// Creates or updates a draft (`saveStickyDraft`). Content over the limit is refused.
    pub fn save(
        &self,
        id: Option<String>,
        content: String,
        kind: StickyKind,
    ) -> Result<StickyDraft, StorageError> {
        if content.encode_utf16().count() > MAX_CONTENT_UNITS {
            return Err(StorageError::Invalid {
                what: format!("sticky content is over {MAX_CONTENT_UNITS} characters"),
            });
        }
        let device = self.device_id.clone();
        self.data.call_blocking(move |conn| {
            let saved =
                sticky_draft::upsert(conn, id.as_deref(), &content, kind, &device, now_ms())?;
            StickyDraft::try_from(saved)
        })
    }

    /// Deletes a draft and queues the delete. `false` when there was none.
    pub fn delete(&self, id: String) -> Result<bool, StorageError> {
        let device = self.device_id.clone();
        self.data
            .call_blocking(move |conn| sticky_draft::delete(conn, &id, &device, now_ms()))
    }
}

impl TryFrom<sticky_draft::StickyDraft> for StickyDraft {
    type Error = StorageError;

    fn try_from(draft: sticky_draft::StickyDraft) -> Result<Self, StorageError> {
        Ok(Self {
            created_at: iso(draft.created_at)?,
            modified_at: iso(draft.modified_at)?,
            kind: draft.kind.as_str().to_owned(),
            id: draft.id,
            content: draft.content,
        })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
