//! `listLinkedNotes` (`apps/desktop/src/main/calendar/linked-notes.ts`): the notes whose
//! relation properties name one calendar item, for the event card.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

/// `CalendarLinkedNote`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedNote {
    pub id: String,
    pub title: String,
    pub emoji: Option<String>,
}

/// The live notes and journal days whose relations name `source_id`, by title. A native
/// event (`source_type` `event`) also counts links to the imported events it was promoted
/// from: a note linked to a Google event before promotion names the mirror. Any other
/// `source_type` is an imported event, named by its relation id.
pub fn linked_notes(
    data: &Connection,
    index: &Connection,
    source_type: &str,
    source_id: &str,
) -> Result<Vec<LinkedNote>, StorageError> {
    let is_event = source_type == "event";
    let mirrors = if is_event {
        promoted_mirror_ids(data, source_id)?
    } else {
        vec![source_id.to_owned()]
    };
    let mut targets: Vec<(&str, String)> = Vec::new();
    if is_event {
        targets.push(("event", source_id.to_owned()));
    }
    for mirror in &mirrors {
        // `encodeExternalEventRelationId`.
        targets.push(("external-event", URL_SAFE_NO_PAD.encode(mirror.as_bytes())));
    }
    let mut note_ids: Vec<String> = Vec::new();
    let mut refs = index
        .prepare(
            "SELECT DISTINCT source_id FROM property_refs WHERE target_type = ?1 AND target_id = ?2",
        )
        .map_err(failed)?;
    for (kind, id) in &targets {
        let rows = refs
            .query_map(params![kind, id], |row| row.get::<_, String>(0))
            .map_err(failed)?;
        for row in rows {
            let id = row.map_err(failed)?;
            if !note_ids.contains(&id) {
                note_ids.push(id);
            }
        }
    }
    if note_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = serde_json::to_string(&note_ids).map_err(|error| StorageError::Failed {
        what: format!("note ids will not serialise: {error}"),
    })?;
    // A note's title and emoji, a day's date (`note_cache` holds both in desktop).
    let mut stmt = data
        .prepare(
            "SELECT id, title, emoji FROM notes
              WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?1))
             UNION ALL
             SELECT id, date, NULL FROM journal_entries
              WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?1))
                AND id NOT IN (SELECT id FROM notes WHERE deleted_at IS NULL)
             ORDER BY 2",
        )
        .map_err(failed)?;
    stmt.query_map([ids], |row| {
        Ok(LinkedNote {
            id: row.get(0)?,
            title: row.get(1)?,
            emoji: row.get(2)?,
        })
    })
    .map_err(failed)?
    .collect::<Result<_, _>>()
    .map_err(failed)
}

/// `promotedMirrorIds`: the imported events the live bindings of event `event_id` point at,
/// archived ones included (promotion archives the mirror it copies).
fn promoted_mirror_ids(data: &Connection, event_id: &str) -> Result<Vec<String>, StorageError> {
    let mut stmt = data
        .prepare(
            "SELECT e.id FROM calendar_bindings b
               JOIN calendar_sources s
                 ON s.provider = b.provider AND s.remote_id = b.remote_calendar_id
                AND s.deleted_at IS NULL
               JOIN calendar_external_events e
                 ON e.source_id = s.id AND e.remote_event_id = b.remote_event_id
                AND e.deleted_at IS NULL
              WHERE b.deleted_at IS NULL AND b.source_type = 'event' AND b.source_id = ?1",
        )
        .map_err(failed)?;
    stmt.query_map([event_id], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}
