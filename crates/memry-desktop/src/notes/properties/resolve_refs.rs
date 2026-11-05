//! Relation chips (`properties:resolveRefs`, `ipc/relation-handlers.ts`; #3530 13q-2): each
//! `memry://<kind>/<id>` value a relation property holds, resolved to what its chip shows.
//!
//! The answer keeps the input's order and length. A malformed value, a missing target and a
//! target whose read fails are each `exists: false` (the last two logged), never an error, so one
//! bad ref cannot blank the property row. Each kind is read through its owner's read, one per
//! ref, and none needs this device's identity ([`RelationTargets`]): a note's listed record, a
//! task, an event, an imported event (synced or subscribed, archived ones included, and through a
//! promotion to the native event), a canvas that is not deleted, and a journal day that has a
//! file (desktop reads the note index, which holds only days with one).

use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use memry_core::api::errors::StorageError;
use memry_core::api::relation_targets::RelationTargets;
use memry_core::domain::property_values::parse_relation_uri;
use serde::Serialize;

use super::super::error::SCOPE;
use super::super::service::NotesService;
use crate::session::OpenVault;

/// `RelationKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum RelationKind {
    Note,
    Task,
    Event,
    ExternalEvent,
    Canvas,
    Journal,
}

/// `ResolvedRelationRef`: a relation value and what its chip shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRelationRefView {
    pub uri: String,
    pub target_type: RelationKind,
    pub target_id: String,
    pub title: String,
    pub exists: bool,
    /// Note targets that are not markdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub file_type: Option<String>,
    /// Note targets with an icon; chips show it instead of the kind icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub emoji: Option<String>,
    /// Task targets in a project; scopes the tasks list when a chip navigates.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub project_id: Option<String>,
    /// Event targets: the calendar moves its range to it before it focuses the event.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub start_at: Option<String>,
    /// Event targets: the calendar item to focus.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub calendar_item_id: Option<String>,
    /// Journal targets: the day, which is also the target id.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub date: Option<String>,
}

impl ResolvedRelationRefView {
    fn missing(uri: &str, target_type: RelationKind, target_id: &str) -> Self {
        Self {
            uri: uri.to_owned(),
            target_type,
            target_id: target_id.to_owned(),
            title: String::new(),
            exists: false,
            file_type: None,
            emoji: None,
            project_id: None,
            start_at: None,
            calendar_item_id: None,
            date: None,
        }
    }

    fn found(uri: &str, target_type: RelationKind, target_id: &str, title: String) -> Self {
        Self {
            title,
            exists: true,
            ..Self::missing(uri, target_type, target_id)
        }
    }
}

impl NotesService {
    /// `resolveRefs`: `uris` resolved one to one, in order.
    pub fn resolve_refs(&self, open: &OpenVault, uris: &[String]) -> Vec<ResolvedRelationRefView> {
        let targets = open.vault.relation_targets();
        uris.iter()
            .map(|uri| resolve_ref(open, &targets, uri))
            .collect()
    }
}

fn resolve_ref(open: &OpenVault, targets: &RelationTargets, uri: &str) -> ResolvedRelationRefView {
    let parsed = parse_relation_uri(uri).and_then(|(kind, id)| {
        let kind = match kind {
            "note" => RelationKind::Note,
            "task" => RelationKind::Task,
            "event" => RelationKind::Event,
            "external-event" => RelationKind::ExternalEvent,
            "canvas" => RelationKind::Canvas,
            "journal" => RelationKind::Journal,
            _ => return None,
        };
        Some((kind, id))
    });
    let Some((kind, id)) = parsed else {
        // The value is the user's frontmatter text, so only its shape is logged.
        let memry_scheme = uri.starts_with("memry://");
        tracing::warn!(
            scope = SCOPE,
            len = uri.len(),
            memry_scheme,
            "malformed relation URI"
        );
        return ResolvedRelationRefView::missing(uri, RelationKind::Note, "");
    };
    read_ref(open, targets, uri, kind, id).unwrap_or_else(|error| {
        tracing::warn!(scope = SCOPE, kind = ?kind, id, %error, "relation target read failed");
        ResolvedRelationRefView::missing(uri, kind, id)
    })
}

fn read_ref(
    open: &OpenVault,
    targets: &RelationTargets,
    uri: &str,
    kind: RelationKind,
    id: &str,
) -> Result<ResolvedRelationRefView, StorageError> {
    let missing = || ResolvedRelationRefView::missing(uri, kind, id);
    let found = |title| ResolvedRelationRefView::found(uri, kind, id, title);
    Ok(match kind {
        RelationKind::Note => match open.vault.note_files().listed_by_id(id)? {
            None => missing(),
            Some(note) => ResolvedRelationRefView {
                file_type: (note.file_type != "markdown").then_some(note.file_type),
                emoji: note.emoji.filter(|emoji| !emoji.is_empty()),
                ..found(note.title)
            },
        },
        RelationKind::Task => match targets.task(id)? {
            None => missing(),
            Some(task) => ResolvedRelationRefView {
                project_id: Some(task.project_id).filter(|project| !project.is_empty()),
                ..found(task.title)
            },
        },
        RelationKind::Event => match targets.event(id)? {
            None => missing(),
            Some(event) => ResolvedRelationRefView {
                start_at: Some(event.start_at),
                calendar_item_id: Some(id.to_owned()),
                ..found(event.title)
            },
        },
        RelationKind::ExternalEvent => {
            let event = match external_row_id(id) {
                Some(row_id) => targets.external_event(&row_id)?,
                None => None,
            };
            match event {
                None => missing(),
                Some(event) => ResolvedRelationRefView {
                    start_at: Some(event.start_at),
                    calendar_item_id: Some(event.calendar_item_id),
                    ..found(event.title)
                },
            }
        }
        RelationKind::Canvas => match targets.canvas(id)? {
            None => missing(),
            Some(canvas) => found(canvas.title.unwrap_or_default()),
        },
        RelationKind::Journal => match targets.day(id)?.and_then(|day| day.path) {
            None => missing(),
            // The day's title is its file's name; the date when that is empty.
            Some(path) => {
                let stem = Path::new(&path).file_stem().and_then(|stem| stem.to_str());
                let title = stem.filter(|stem| !stem.is_empty()).unwrap_or(id);
                ResolvedRelationRefView {
                    date: Some(id.to_owned()),
                    ..found(title.to_owned())
                }
            }
        },
    })
}

/// `decodeExternalEventRelationId`: the mirror row id a relation id names, in unpadded
/// base64url of UTF-8; `None` when it is not.
fn external_row_id(id: &str) -> Option<String> {
    String::from_utf8(URL_SAFE_NO_PAD.decode(id).ok()?).ok()
}
