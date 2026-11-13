//! The portals surface (#4415): `portals:get-usage`, `portals:stamp-anchor` and `portals:search`
//! of desktop `ipc/portals-handlers.ts`, in the shapes of `@memry/contracts/portals-api`.
//!
//! The core answers who shows a note and which blocks a search finds
//! ([`memry_core::domain::search::portal_reads`]) and writes the anchor into the note's body
//! ([`memry_core::domain::body_write::stamp_anchor`]). The stamp is a body edit like a window's:
//! stored with its outbox row, caught up into every editor window that holds the note (the
//! editor host fans it out as an app write), and written to the note's file by the write-back
//! this schedules, so editor, document and file agree.

use memry_core::api::errors::StorageError;
use memry_core::crdt::errors::CrdtError;
use memry_core::domain::search::portal_reads::{HostKind, PortalBlockHit, PortalHost};
use memry_core::portal::StampOutcome;
use serde::{Deserialize, Serialize};

use super::error::{NotesError, SCOPE};
use super::service::NotesService;
use crate::session::OpenVault;

/// `PortalHost['kind']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum PortalHostKind {
    Portal,
    Link,
}

/// `PortalHostSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PortalHostView {
    pub note_id: String,
    pub title: String,
    pub path: String,
    pub count: u32,
    pub kind: PortalHostKind,
    /// A portal's first matching fence among the host's portal fences; absent for a link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u32>,
}

impl From<PortalHost> for PortalHostView {
    fn from(host: PortalHost) -> Self {
        let (kind, ordinal) = match host.kind {
            HostKind::Portal { ordinal } => (PortalHostKind::Portal, Some(ordinal)),
            HostKind::Link => (PortalHostKind::Link, None),
        };
        Self {
            note_id: host.note_id,
            title: host.title,
            path: host.path,
            count: host.count,
            kind,
            ordinal,
        }
    }
}

/// `PortalGetUsageResultSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct PortalUsageView {
    pub hosts: Vec<PortalHostView>,
}

/// Why a stamp was refused (`PortalStampAnchorResultSchema`'s `reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum StampRefusal {
    MissingNote,
    MissingBlock,
    Locked,
}

/// `PortalStampAnchorResultSchema`: `anchor` on success, `reason` otherwise. The renderer's seam
/// turns it into the contract's union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StampAnchorView {
    pub anchor: Option<String>,
    pub reason: Option<StampRefusal>,
}

/// `PortalSearchSchema`, checked by the command.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PortalSearchInput {
    pub text: Option<String>,
    pub tag: Option<String>,
    pub limit: u32,
}

/// `PortalSearchResultItemSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PortalSearchItemView {
    pub note_id: String,
    pub title: String,
    pub path: String,
    pub block_id: String,
    pub anchor: Option<String>,
    pub text: String,
    pub parent_text: Option<String>,
}

impl From<PortalBlockHit> for PortalSearchItemView {
    fn from(hit: PortalBlockHit) -> Self {
        Self {
            note_id: hit.note_id,
            title: hit.title,
            path: hit.path,
            block_id: hit.block_id,
            anchor: hit.anchor,
            text: hit.text,
            parent_text: hit.parent_text,
        }
    }
}

/// `PortalSearchResultSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct PortalSearchView {
    pub results: Vec<PortalSearchItemView>,
    pub truncated: bool,
}

/// The notes that show `note_id`, or its block `anchor`.
pub fn usage(
    open: &OpenVault,
    note_id: &str,
    anchor: Option<&str>,
) -> Result<PortalUsageView, StorageError> {
    let hosts = open.vault.search()?.portal_usage(note_id, anchor)?;
    Ok(PortalUsageView {
        hosts: hosts.into_iter().map(PortalHostView::from).collect(),
    })
}

/// The blocks a portal search finds. A candidate note whose document does not replay is skipped
/// and logged.
pub fn search(
    open: &OpenVault,
    input: &PortalSearchInput,
) -> Result<PortalSearchView, StorageError> {
    let found = open.vault.search()?.portal_search(
        input.text.as_deref(),
        input.tag.as_deref(),
        input.limit as usize,
    )?;
    for (note_id, error) in &found.unreadable {
        tracing::warn!(
            scope = SCOPE,
            note_id,
            "a portal search skipped a note: {error}"
        );
    }
    Ok(PortalSearchView {
        results: found.results.into_iter().map(Into::into).collect(),
        truncated: found.truncated,
    })
}

impl NotesService {
    /// Gives the block `block_id` of note `note_id` its ` ^anchor`, or answers the one it has,
    /// and schedules the note's write-back when the body changed.
    pub fn stamp_anchor(
        &self,
        open: &OpenVault,
        note_id: &str,
        block_id: &str,
    ) -> Result<StampAnchorView, NotesError> {
        let writer = open.vault.notes_writer(self.store.clone())?;
        let refused = |reason| StampAnchorView {
            anchor: None,
            reason: Some(reason),
        };
        let outcome = match writer.stamp_anchor(note_id.to_owned(), block_id.to_owned()) {
            Ok(outcome) => outcome,
            Err(CrdtError::Locked { .. }) => return Ok(refused(StampRefusal::Locked)),
            Err(error) => return Err(error.into()),
        };
        let anchor = match outcome {
            None => return Ok(refused(StampRefusal::MissingNote)),
            Some(StampOutcome::MissingBlock) => return Ok(refused(StampRefusal::MissingBlock)),
            Some(StampOutcome::Existing(anchor)) => anchor,
            Some(StampOutcome::Stamped(anchor)) => {
                tracing::info!(scope = SCOPE, note_id, "stamped a portal anchor");
                self.tier.schedule(note_id);
                anchor
            }
        };
        Ok(StampAnchorView {
            anchor: Some(anchor),
            reason: None,
        })
    }
}
