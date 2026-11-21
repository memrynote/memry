//! The voice memo vectors of `index.db` and the state rows that record them: Electron's
//! `apps/desktop/src/main/database/voice-vectors.ts`, and the plan of
//! `projections/projectors/voice-embedding-projector.ts` (`planVoiceEmbedding`). Desktop's voice
//! projector embeds; this module lists the memos, plans each one and writes what came back.
//!
//! A memo's windows live in `vec_voice` under `<item_id>#<n>` and its `voice_embedding_state`
//! row records what they were computed from (its transcript or its audio), the input version
//! and how many windows there are, written in one transaction. The memos live in `data.db` and
//! the vectors in `index.db`, so the caller joins [`items`] with [`state`].

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::embedding_input::{
    EMBEDDING_INPUT_VERSION, EmbeddingTask, build_embedding_input,
};
use crate::storage::vec::{VecTable, nearest, to_blob};

/// `AUDIO_EMBEDDING_INPUT_VERSION`: bump when how a recording is windowed or encoded changes.
pub const AUDIO_EMBEDDING_INPUT_VERSION: u32 = 1;
/// `MIN_TRANSCRIPT_WORDS`: Whisper turns silence and noise into one or two words.
const MIN_TRANSCRIPT_WORDS: usize = 3;

/// The words `planVoiceEmbedding` counts: `/\p{L}[\p{L}\p{N}']*/gu`.
static WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{L}[\p{L}\p{N}']*").expect("a valid pattern"));

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("voice embeddings: {err}"),
    }
}

/// What a memo's vectors were computed from (`VoiceVectorSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceSource {
    Transcript,
    Audio,
}

impl VoiceSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transcript => "transcript",
            Self::Audio => "audio",
        }
    }

    /// `None` for a source this build does not know (a newer build's row).
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "transcript" => Some(Self::Transcript),
            "audio" => Some(Self::Audio),
            _ => None,
        }
    }

    /// `inputVersion`: the text input's version for a transcript, the audio one for audio.
    pub fn input_version(self) -> u32 {
        match self {
            Self::Transcript => EMBEDDING_INPUT_VERSION,
            Self::Audio => AUDIO_EMBEDDING_INPUT_VERSION,
        }
    }
}

/// A voice memo as the projector reads it (`VoiceItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceItem {
    pub id: String,
    pub title: String,
    pub transcription: Option<String>,
    pub transcription_status: Option<String>,
    pub attachment_path: Option<String>,
}

/// How a memo is indexed (`VoiceEmbeddingPlan`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoicePlan {
    /// Its transcription is still running; its completion publishes the memo again.
    Wait,
    /// Embed this text (title and transcript, empty when too short) with the text model.
    Transcript(String),
    /// Embed the recording: the memo has no usable transcript.
    Audio,
}

impl VoicePlan {
    pub fn source(&self) -> Option<VoiceSource> {
        match self {
            Self::Wait => None,
            Self::Transcript(_) => Some(VoiceSource::Transcript),
            Self::Audio => Some(VoiceSource::Audio),
        }
    }
}

/// `planVoiceEmbedding`: a memo with a usable transcript (complete, three words or more) is
/// embedded from it with the text model; any other (failed, never requested, silence, music) is
/// embedded from its audio.
pub fn plan(item: &VoiceItem) -> VoicePlan {
    let status = item.transcription_status.as_deref();
    if matches!(status, Some("pending" | "processing")) {
        return VoicePlan::Wait;
    }
    let transcript = item.transcription.as_deref().unwrap_or("");
    if status == Some("complete") && WORD.find_iter(transcript).count() >= MIN_TRANSCRIPT_WORDS {
        return VoicePlan::Transcript(build_embedding_input(
            Some(&item.title),
            Some(transcript),
            EmbeddingTask::Document,
        ));
    }
    VoicePlan::Audio
}

/// `readVoiceItems`: the live voice memos, or the one with `item_id`. Filed and archived memos
/// stay searchable; a deleted one (`deleted_at`, desktop's hard delete) is gone.
pub fn items(data: &Connection, item_id: Option<&str>) -> Result<Vec<VoiceItem>, StorageError> {
    let mut statement = data
        .prepare(
            "SELECT id, title, transcription, transcription_status, attachment_path
               FROM inbox_view
              WHERE type = 'voice' AND deleted_at IS NULL AND (?1 IS NULL OR id = ?1)
              ORDER BY id",
        )
        .map_err(failed)?;
    statement
        .query_map([item_id], |row| {
            Ok(VoiceItem {
                id: row.get(0)?,
                title: row.get(1)?,
                transcription: row.get(2)?,
                transcription_status: row.get(3)?,
                attachment_path: row.get(4)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// A `voice_embedding_state` row (`VoiceVectorState`). `source` is kept as stored, so a newer
/// build's source reads as owed rather than failing the listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceEmbeddingState {
    pub item_id: String,
    pub source: String,
    pub input_version: u32,
    pub chunks: u32,
}

impl VoiceEmbeddingState {
    /// Whether the stored vectors are the ones `plan` asks for.
    pub fn matches(&self, source: VoiceSource) -> bool {
        self.source == source.as_str() && self.input_version == source.input_version()
    }
}

/// `readVoiceVectorStates`.
pub fn state(index: &Connection) -> Result<Vec<VoiceEmbeddingState>, StorageError> {
    let mut statement = index
        .prepare(
            "SELECT item_id, source, input_version, chunks FROM voice_embedding_state
              ORDER BY item_id",
        )
        .map_err(failed)?;
    statement
        .query_map([], |row| {
            Ok(VoiceEmbeddingState {
                item_id: row.get(0)?,
                source: row.get(1)?,
                input_version: row.get(2)?,
                chunks: row.get(3)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn delete_in(index: &Connection, item_id: &str) -> Result<(), StorageError> {
    let chunks: u32 = index
        .query_row(
            "SELECT chunks FROM voice_embedding_state WHERE item_id = ?1",
            [item_id],
            |row| row.get(0),
        )
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(0),
            err => Err(err),
        })
        .map_err(failed)?;
    for n in 0..chunks {
        index
            .execute(
                "DELETE FROM vec_voice WHERE chunk_id = ?1",
                [format!("{item_id}#{n}")],
            )
            .map_err(failed)?;
    }
    index
        .execute(
            "DELETE FROM voice_embedding_state WHERE item_id = ?1",
            [item_id],
        )
        .map_err(failed)?;
    Ok(())
}

/// `deleteVoiceVectors`: the memo's windows and its state row, in one transaction.
pub fn delete(index: &Connection, item_id: &str) -> Result<(), StorageError> {
    let transaction = index.unchecked_transaction().map_err(failed)?;
    delete_in(&transaction, item_id)?;
    transaction.commit().map_err(failed)
}

/// `replaceVoiceVectors`: every window of the memo replaced with `vectors`, and its state row,
/// in one transaction.
pub fn replace(
    index: &Connection,
    item_id: &str,
    source: VoiceSource,
    vectors: &[Vec<f32>],
) -> Result<(), StorageError> {
    let transaction = index.unchecked_transaction().map_err(failed)?;
    delete_in(&transaction, item_id)?;
    for (n, vector) in vectors.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO vec_voice (chunk_id, embedding) VALUES (?1, ?2)",
                params![format!("{item_id}#{n}"), to_blob(vector)],
            )
            .map_err(failed)?;
    }
    transaction
        .execute(
            "INSERT INTO voice_embedding_state (item_id, source, input_version, chunks)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                item_id,
                source.as_str(),
                source.input_version(),
                vectors.len() as u32
            ],
        )
        .map_err(failed)?;
    transaction.commit().map_err(failed)
}

/// The voice projector's `rebuild`: every voice vector and state row, in one transaction.
pub fn clear(index: &Connection) -> Result<(), StorageError> {
    let transaction = index.unchecked_transaction().map_err(failed)?;
    transaction
        .execute_batch("DELETE FROM vec_voice; DELETE FROM voice_embedding_state;")
        .map_err(failed)?;
    transaction.commit().map_err(failed)
}

/// `nearestVoiceItems`: the memos whose windows lie nearest `query`, best first, one hit per
/// memo (its best window) with its cosine and what its vectors were computed from. A window
/// with no state row, or a source this build does not know, answers nothing.
pub fn nearest_items(
    index: &Connection,
    query: &[f32],
    k: usize,
) -> Result<Vec<(String, f64, VoiceSource)>, StorageError> {
    let sources: HashMap<String, VoiceSource> = state(index)?
        .into_iter()
        .filter_map(|row| Some((row.item_id, VoiceSource::parse(&row.source)?)))
        .collect();
    let mut hits: Vec<(String, f64, VoiceSource)> = Vec::new();
    for (chunk, distance) in nearest(index, VecTable::Voice, query, k)? {
        let id = chunk.rsplit_once('#').map_or(chunk.as_str(), |(id, _)| id);
        if hits.iter().any(|(seen, _, _)| seen == id) {
            continue;
        }
        if let Some(source) = sources.get(id) {
            hits.push((id.to_owned(), 1.0 - distance, *source));
        }
    }
    Ok(hits)
}

#[cfg(test)]
#[path = "voice_embeddings_tests.rs"]
mod tests;
