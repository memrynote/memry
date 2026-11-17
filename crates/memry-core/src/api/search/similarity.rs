//! The reads behind note similarity ([`crate::domain::similarity::SimilarityStore`]), over the
//! stored `vec_note_similar` vectors, the index's links, relations and portals, and the notes of
//! `data.db`; the tags are [`Search::tags_of_notes`]. Electron's `similarity/index.ts` reads the same from its index database.
//! Desktop only; not on the FFI surface.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::journal_ops::links::{id_list, live_items};
use crate::domain::notes::failed;
use crate::domain::similarity::NoteInfo;
use crate::storage::vec::{self, VecTable};

use super::Search;

fn strings(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<String>, StorageError> {
    let mut statement = conn.prepare(sql).map_err(failed)?;
    statement
        .query_map(params, |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

impl Search {
    /// The note's stored similarity vector (`readVector`).
    pub fn similarity_vector(&self, note_id: &str) -> Result<Option<Vec<f32>>, StorageError> {
        let note_id = note_id.to_owned();
        self.index
            .read_blocking(move |index| vec::vector(index, VecTable::NoteSimilar, &note_id))
    }

    /// The `k` similarity vectors nearest `vector`, closest first, with their cosine distance.
    pub fn similarity_nearest(
        &self,
        vector: &[f32],
        k: usize,
    ) -> Result<Vec<(String, f64)>, StorageError> {
        let vector = vector.to_vec();
        self.index
            .read_blocking(move |index| vec::nearest(index, VecTable::NoteSimilar, &vector, k))
    }

    /// Electron's `linkedNoteIds` (`similarity/index.ts`): the resolved targets of the note's
    /// wiki-links (`getOutgoingLinks`), the notes linking to it, the live notes whose relations
    /// name it or its journal day, the live notes hosting a portal of it (`getIncomingReferences`)
    /// and the notes its own relations name (`getPropertyRefsForNote`).
    pub fn similarity_linked_note_ids(
        &self,
        note_id: &str,
    ) -> Result<HashSet<String>, StorageError> {
        let id = note_id.to_owned();
        let date = self.data.read_blocking(move |data| {
            Ok(live_items(data, [id.as_str()].into_iter())?
                .remove(&id)
                .and_then(|source| source.named().2))
        })?;
        let id = note_id.to_owned();
        let (mut linked, referring) = self.index.read_blocking(move |index| {
            let mut linked: HashSet<String> = strings(
                index,
                "SELECT target_id FROM note_links WHERE source_id = ?1 AND target_id IS NOT NULL \
                 UNION SELECT source_id FROM note_links WHERE target_id = ?1 \
                 UNION SELECT target_id FROM property_refs \
                       WHERE source_id = ?1 AND target_type = 'note'",
                params![id],
            )?
            .into_iter()
            .collect();
            linked.remove(&id);
            let referring = strings(
                index,
                "SELECT source_id FROM property_refs \
                 WHERE (target_type = 'note' AND target_id = ?1) \
                    OR (target_type = 'journal' AND target_id = ?2) \
                 UNION SELECT host_note_id FROM portal_refs WHERE source_note_id = ?1",
                params![id, date],
            )?;
            Ok((linked, referring))
        })?;
        // Electron drops a relation or portal whose source note is gone (`noteCacheExists`,
        // `getPortalHostIds`' join); a link row is dropped with its source.
        let live = self.data.read_blocking(move |data| {
            Ok(live_items(data, referring.iter().map(String::as_str))?
                .into_keys()
                .collect::<Vec<_>>())
        })?;
        linked.extend(live.into_iter().filter(|id| id != note_id));
        Ok(linked)
    }

    /// The live notes and journal days among `ids` that have a file, as a similarity answer shows
    /// them (Electron's `note_cache` row: title, path, emoji, snippet). A day is titled by its
    /// date.
    pub fn similarity_notes(
        &self,
        ids: &[String],
    ) -> Result<HashMap<String, NoteInfo>, StorageError> {
        let list = id_list(ids.iter().map(String::as_str))?;
        let mut out: HashMap<String, NoteInfo> = self.data.read_blocking(move |data| {
            let mut statement = data
                .prepare(
                    "SELECT n.id, n.title, f.path, n.emoji, 0 FROM notes n \
                     JOIN note_files f ON f.note_id = n.id \
                     WHERE n.deleted_at IS NULL AND n.id IN (SELECT value FROM json_each(?1)) \
                     UNION ALL \
                     SELECT j.id, j.date, f.path, NULL, 1 FROM journal_entries j \
                     JOIN note_files f ON f.note_id = j.id \
                     WHERE j.deleted_at IS NULL AND j.id IN (SELECT value FROM json_each(?1)) \
                     ORDER BY 5",
                )
                .map_err(failed)?;
            let rows = statement
                .query_map(params![list], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        NoteInfo {
                            title: row.get(1)?,
                            path: row.get(2)?,
                            emoji: row.get(3)?,
                            snippet: None,
                        },
                    ))
                })
                .map_err(failed)?;
            let mut out = HashMap::new();
            for row in rows {
                let (id, info) = row.map_err(failed)?;
                // A note wins an id it shares with a day, as `live_items` answers it.
                out.entry(id).or_insert(info);
            }
            Ok(out)
        })?;
        if out.is_empty() {
            return Ok(out);
        }
        let found = id_list(out.keys().map(String::as_str))?;
        let snippets: Vec<(String, String)> = self.index.read_blocking(move |index| {
            let mut statement = index
                .prepare(
                    "SELECT note_id, snippet FROM note_stats \
                     WHERE note_id IN (SELECT value FROM json_each(?1))",
                )
                .map_err(failed)?;
            statement
                .query_map(params![found], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(failed)?
                .collect::<Result<_, _>>()
                .map_err(failed)
        })?;
        for (id, snippet) in snippets {
            if let Some(info) = out.get_mut(&id) {
                info.snippet = Some(snippet);
            }
        }
        Ok(out)
    }
}
