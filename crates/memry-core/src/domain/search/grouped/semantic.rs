//! The semantic leg's core half: desktop's `semanticNoteHits`
//! (`apps/desktop/src/main/search/semantic.ts:46-131`) once the query is embedded.
//!
//! The shell decides whether to embed ([`wants`], then its AI setting and whether the
//! model is loaded), embeds `task: search result | query: <q>`
//! ([`crate::domain::embedding_input::build_query_embedding_input`]) and hands the
//! vector to [`note_hits`], which reads the nearest note windows from `index.db`.
//! A note is as near as its nearest window: its head vector (`vec_notes`) or a later
//! one (`vec_note_chunks`, `<note_id>#<n>`). Hits under the query floor are dropped.
//!
//! The image leg (`semantic.ts:85-99`) reads `vec_images` when image embeddings are on:
//! an image answers for the note that owns it, at its own floor of 0.68, shifted down by
//! the 0.03 gap to the text floor. The voice leg (`semantic.ts:106-122`) reads `vec_voice`:
//! a memo answers for itself, at the text floor when embedded from its transcript and at the
//! audio floor of 0.68 (shifted down the same way) when embedded from its audio.

#[cfg(feature = "vec")]
use crate::domain::voice_embeddings::VoiceSource;

/// A note, journal day or voice memo whose vector is near the query
/// (`search-semantic-merge.ts:17-21`).
#[derive(Debug, Clone, PartialEq)]
pub struct SemanticHit {
    pub id: String,
    /// Query-to-document cosine, at or above [`QUERY_SIMILARITY_FLOOR`].
    pub cosine: f64,
}

/// `EMBEDDING_QUERY_SIMILARITY_FLOOR` (`lib/embeddings-constants.ts:42`).
pub const QUERY_SIMILARITY_FLOOR: f64 = 0.65;
/// `EMBEDDING_IMAGE_QUERY_SIMILARITY_FLOOR` (`lib/embeddings-constants.ts:57`).
pub const IMAGE_QUERY_SIMILARITY_FLOOR: f64 = 0.68;
/// `EMBEDDING_AUDIO_QUERY_SIMILARITY_FLOOR` (`lib/embeddings-constants.ts:73`).
pub const AUDIO_QUERY_SIMILARITY_FLOOR: f64 = 0.68;
/// `MIN_QUERY_LENGTH` (`semantic.ts:26`), in UTF-16 units as JavaScript counts.
const MIN_QUERY_LENGTH: usize = 3;
/// `NEIGHBOURS` (`semantic.ts:28`): read before the floor applies.
#[cfg_attr(not(feature = "vec"), allow(dead_code))]
const NEIGHBOURS: usize = 30;

/// Whether the query is worth embedding: three units or more once trimmed, and no
/// FTS operator (`AND`, `OR`, `NOT` as words, or a quoted phrase), which asks for
/// literal matches (`semantic.ts:38-50`).
pub fn wants(text: &str) -> bool {
    let query = text.trim();
    query.encode_utf16().count() >= MIN_QUERY_LENGTH && !has_operators(query)
}

/// `/\b(AND|OR|NOT)\b/.test(text) || /"[^"]+"/.test(text)` (`semantic.ts:38-40`).
/// `\b` is an ASCII word boundary in JavaScript.
fn has_operators(text: &str) -> bool {
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    let operator = ["AND", "OR", "NOT"].iter().any(|op| {
        text.match_indices(op).any(|(at, _)| {
            !word(text[..at].chars().next_back()) && !word(text[at + op.len()..].chars().next())
        })
    });
    // Any run between two consecutive quotes, so `"" "` holds the phrase ` `.
    let runs: Vec<&str> = text.split('"').collect();
    let quoted = runs.len() > 2 && runs[1..runs.len() - 1].iter().any(|run| !run.is_empty());
    operator || quoted
}

/// A note is as near as its nearest window or image (`consider`, `semantic.ts:77-79`).
fn consider(hits: &mut Vec<SemanticHit>, id: &str, cosine: f64) {
    match hits.iter_mut().find(|hit| hit.id == id) {
        Some(hit) => hit.cosine = hit.cosine.max(cosine),
        None => hits.push(SemanticHit {
            id: id.to_owned(),
            cosine,
        }),
    }
}

/// Merges the nearest head windows (`notes`, by note id) and later windows
/// (`chunks`, by `<note_id>#<n>`), each with its cosine distance, into one hit per
/// note at its best cosine and drops those under the floor; then each image hit
/// (`images`, by owning note, with its cosine) at or above the image floor counts
/// for its note, shifted down to the text floor's scale. Best first, at most
/// [`NEIGHBOURS`] (`semantic.ts:66-104`). Ties keep the order seen.
pub fn best_windows(
    notes: impl IntoIterator<Item = (String, f64)>,
    chunks: impl IntoIterator<Item = (String, f64)>,
    images: impl IntoIterator<Item = (String, f64)>,
) -> Vec<SemanticHit> {
    let mut hits: Vec<SemanticHit> = Vec::new();
    for (id, distance) in notes {
        consider(&mut hits, &id, 1.0 - distance);
    }
    for (id, distance) in chunks {
        let note = id.rsplit_once('#').map_or(id.as_str(), |(note, _)| note);
        consider(&mut hits, note, 1.0 - distance);
    }
    hits.retain(|hit| hit.cosine >= QUERY_SIMILARITY_FLOOR);
    let shift = IMAGE_QUERY_SIMILARITY_FLOOR - QUERY_SIMILARITY_FLOOR;
    for (note, cosine) in images {
        if cosine >= IMAGE_QUERY_SIMILARITY_FLOOR {
            consider(&mut hits, &note, cosine - shift);
        }
    }
    hits.sort_by(|a, b| b.cosine.total_cmp(&a.cosine));
    hits.truncate(NEIGHBOURS);
    hits
}

/// `notes` (from [`best_windows`]) with the voice memos near the query (`semantic.ts:106-123`):
/// each memo `(id, cosine, source)` at or above its source's floor, an audio-embedded one
/// shifted down to the text floor's scale. Best first; ties keep notes first.
#[cfg(feature = "vec")]
pub fn with_voice(
    mut notes: Vec<SemanticHit>,
    voice: impl IntoIterator<Item = (String, f64, VoiceSource)>,
) -> Vec<SemanticHit> {
    let audio_shift = AUDIO_QUERY_SIMILARITY_FLOOR - QUERY_SIMILARITY_FLOOR;
    for (id, cosine, source) in voice {
        let cosine = match source {
            VoiceSource::Transcript if cosine >= QUERY_SIMILARITY_FLOOR => cosine,
            VoiceSource::Audio if cosine >= AUDIO_QUERY_SIMILARITY_FLOOR => cosine - audio_shift,
            _ => continue,
        };
        notes.push(SemanticHit { id, cosine });
    }
    notes.sort_by(|a, b| b.cosine.total_cmp(&a.cosine));
    notes
}

/// The notes and journal days nearest `query` (an embedded search query), best
/// first: the [`NEIGHBOURS`] nearest of `vec_notes` and of `vec_note_chunks`, and of
/// `vec_images` when `images` is on (`isImageEmbeddingEnabled`), merged by
/// [`best_windows`], then the voice memos nearest it ([`with_voice`]). A note vector
/// store that fails is logged and answers no hits, so the search falls back to the
/// index (`semantic.ts:126-129`); a failing image or voice leg leaves the note hits
/// (`semantic.ts:100-103`, 119-122).
#[cfg(feature = "vec")]
pub fn note_hits(index: &rusqlite::Connection, query: &[f32], images: bool) -> Vec<SemanticHit> {
    use crate::domain::image_embeddings::nearest_notes;
    use crate::domain::voice_embeddings::nearest_items;
    use crate::storage::vec::{VecTable, nearest};
    let windows = nearest(index, VecTable::Notes, query, NEIGHBOURS).and_then(|notes| {
        nearest(index, VecTable::NoteChunks, query, NEIGHBOURS).map(|chunks| (notes, chunks))
    });
    let (notes, chunks) = match windows {
        Ok(windows) => windows,
        Err(error) => {
            eprintln!("memry search: the semantic leg failed, answering from the index: {error}");
            return Vec::new();
        }
    };
    let image_hits = if images {
        nearest_notes(index, query, NEIGHBOURS).unwrap_or_else(|error| {
            eprintln!("memry search: image search failed, answering from note vectors: {error}");
            Vec::new()
        })
    } else {
        Vec::new()
    };
    let voice = nearest_items(index, query, NEIGHBOURS).unwrap_or_else(|error| {
        eprintln!("memry search: voice memo search failed, answering from note vectors: {error}");
        Vec::new()
    });
    with_voice(best_windows(notes, chunks, image_hits), voice)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(id: &str, cosine: f64) -> SemanticHit {
        SemanticHit {
            id: id.to_owned(),
            cosine,
        }
    }

    /// `semantic.test.ts`: "answers empty without embedding for short, operator or
    /// AI-off queries" (the AI setting is the shell's).
    #[test]
    fn short_and_operator_queries_are_not_embedded() {
        assert!(wants("cat"));
        assert!(wants("  cat  "));
        assert!(!wants("ab"));
        assert!(!wants(" ab "));
        assert!(!wants("cat AND dog"));
        assert!(!wants("NOT cats"));
        assert!(!wants("cats OR"));
        assert!(!wants("say \"hello\" there"));
        assert!(wants("ANDROID notes"), "AND inside a word is no operator");
        assert!(wants("cats and dogs"), "lowercase is no operator");
        assert!(wants("say \"\" there"), "an empty quote is no phrase");
        assert!(wants("a \"open quote"));
        assert!(
            !wants("x\"\" \"y"),
            "the run between the 2nd and 3rd quote is a phrase"
        );
        assert!(wants("日本語"), "three UTF-16 units");
        assert!(!wants("😀"), "two UTF-16 units");
    }

    /// "embeds the query with the search prefix and drops hits under the query floor".
    #[test]
    fn hits_under_the_floor_are_dropped() {
        let hits = best_windows(
            [("near".to_owned(), 0.2), ("far".to_owned(), 0.4)],
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "near");
        assert!((hits[0].cosine - 0.8).abs() < 1e-12);
    }

    #[test]
    fn a_note_is_as_near_as_its_nearest_window() {
        let hits = best_windows(
            [("a".to_owned(), 0.3), ("b".to_owned(), 0.1)],
            [
                ("a#1".to_owned(), 0.05),
                ("a#2".to_owned(), 0.25),
                ("c#1".to_owned(), 0.2),
                ("c#x#2".to_owned(), 0.15),
            ],
            Vec::new(),
        );
        let got: Vec<(&str, f64)> = hits.iter().map(|h| (h.id.as_str(), h.cosine)).collect();
        assert_eq!(got.len(), 4);
        assert_eq!(got[0].0, "a");
        assert!((got[0].1 - 0.95).abs() < 1e-12);
        assert_eq!(got[1].0, "b");
        assert_eq!(got[2].0, "c#x", "the window number is after the last #");
        assert_eq!(got[3].0, "c");
    }

    #[test]
    fn at_most_thirty_hits() {
        let notes = (0..40).map(|at| (format!("n{at}"), 0.1 + f64::from(at) / 1000.0));
        let hits = best_windows(notes, Vec::new(), Vec::new());
        assert_eq!(hits.len(), 30);
        assert_eq!(hits[0], hit("n0", 0.9));
        assert_eq!(hits[29].id, "n29");
    }

    /// `search-semantic.test.ts` voice memos: a transcript hit at the text floor, an audio
    /// hit at the audio floor shifted down by the gap, both merged with the notes by cosine.
    #[cfg(feature = "vec")]
    #[test]
    fn voice_memos_answer_at_their_source_floor() {
        let notes = vec![hit("note", 0.8)];
        let hits = with_voice(
            notes,
            [
                ("spoken".to_owned(), 0.9, VoiceSource::Transcript),
                ("quiet".to_owned(), 0.64, VoiceSource::Transcript),
                ("music".to_owned(), 0.78, VoiceSource::Audio),
                ("noise".to_owned(), 0.67, VoiceSource::Audio),
                ("edge".to_owned(), 0.65, VoiceSource::Transcript),
            ],
        );
        let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["spoken", "note", "music", "edge"]);
        assert!(
            (hits[2].cosine - 0.75).abs() < 1e-12,
            "0.78 less the 0.03 gap"
        );
    }

    /// Real vec0 tables: the stored vectors answer by cosine.
    #[cfg(feature = "vec")]
    #[test]
    fn note_hits_reads_the_nearest_windows_of_the_index() {
        use crate::storage::index_db::open_or_rebuild;
        use crate::storage::test_support::temp_dir;
        use crate::storage::vec::{EMBEDDING_DIMENSION, VecTable, to_blob};

        let axis = |at: usize, weight: f32| {
            let mut vector = vec![0.0_f32; EMBEDDING_DIMENSION];
            vector[0] = weight;
            vector[at] = (1.0 - weight * weight).sqrt();
            vector
        };
        let dir = temp_dir("semantic-note-hits");
        let opened = open_or_rebuild(&dir.path().join("index.db")).expect("open");
        let hits = opened
            .db
            .call_blocking(move |conn| {
                let put = |table: VecTable, id: &str, vector: Vec<f32>| {
                    conn.execute(
                        &format!(
                            "INSERT INTO {} ({}, embedding) VALUES (?1, ?2)",
                            table.name(),
                            table.id_column()
                        ),
                        rusqlite::params![id, to_blob(&vector)],
                    )
                    .map(|_| ())
                    .map_err(super::super::super::failed)
                };
                put(VecTable::Notes, "near", axis(1, 0.9))?;
                put(VecTable::Notes, "far", axis(2, 0.5))?;
                put(VecTable::Notes, "chunked", axis(3, 0.6))?;
                put(VecTable::NoteChunks, "chunked#1", axis(4, 0.95))?;
                let mut query = vec![0.0_f32; EMBEDDING_DIMENSION];
                query[0] = 1.0;
                Ok(note_hits(conn, &query, false))
            })
            .expect("note hits");
        let got: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(got, ["chunked", "near"]);
        assert!((hits[0].cosine - 0.95).abs() < 1e-6);
        assert!((hits[1].cosine - 0.9).abs() < 1e-6);
    }

    /// `semantic.ts:126-129`: a vector store that will not answer leaves the search
    /// to the index.
    #[cfg(feature = "vec")]
    #[test]
    fn a_failing_vector_store_answers_no_hits() {
        use crate::storage::index_db::open_or_rebuild;
        use crate::storage::test_support::temp_dir;
        use crate::storage::vec::EMBEDDING_DIMENSION;

        let dir = temp_dir("semantic-note-hits-fail");
        let opened = open_or_rebuild(&dir.path().join("index.db")).expect("open");
        let hits = opened
            .db
            .call_blocking(|conn| {
                conn.execute_batch("DROP TABLE vec_notes;")
                    .map_err(super::super::super::failed)?;
                Ok(note_hits(conn, &vec![1.0_f32; EMBEDDING_DIMENSION], true))
            })
            .expect("note hits");
        assert!(hits.is_empty());
    }

    /// `semantic.ts:85-99`: an image counts for its note at or above 0.68, shifted down by
    /// 0.03, and lifts a note no text window found.
    #[test]
    fn an_image_counts_for_its_note_at_its_own_floor_shifted_down() {
        let hits = best_windows(
            [("a".to_owned(), 0.3)],
            Vec::new(),
            [
                ("a".to_owned(), 0.80),
                ("b".to_owned(), 0.70),
                ("c".to_owned(), 0.6799),
            ],
        );
        let got: Vec<(&str, f64)> = hits.iter().map(|h| (h.id.as_str(), h.cosine)).collect();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0].0, "a");
        assert!(
            (got[0].1 - 0.77).abs() < 1e-12,
            "the image beat the text window"
        );
        assert_eq!(got[1].0, "b");
        assert!((got[1].1 - 0.67).abs() < 1e-12);
    }

    /// Real vec0 tables: `vec_images` keys answer for the note before their first `/`, only
    /// when image embeddings are on, and a broken image table leaves the note hits.
    #[cfg(feature = "vec")]
    #[test]
    fn note_hits_reads_image_vectors_when_images_are_on() {
        use crate::storage::index_db::open_or_rebuild;
        use crate::storage::test_support::temp_dir;
        use crate::storage::vec::{EMBEDDING_DIMENSION, to_blob};

        let axis = |at: usize, weight: f32| {
            let mut vector = vec![0.0_f32; EMBEDDING_DIMENSION];
            vector[0] = weight;
            vector[at] = (1.0 - weight * weight).sqrt();
            vector
        };
        let dir = temp_dir("semantic-image-hits");
        let opened = open_or_rebuild(&dir.path().join("index.db")).expect("open");
        let (on, off, broken) = opened
            .db
            .call_blocking(move |conn| {
                let put = |table: &str, column: &str, id: &str, vector: Vec<f32>| {
                    conn.execute(
                        &format!("INSERT INTO {table} ({column}, embedding) VALUES (?1, ?2)"),
                        rusqlite::params![id, to_blob(&vector)],
                    )
                    .map(|_| ())
                    .map_err(super::super::super::failed)
                };
                put("vec_notes", "note_id", "text", axis(1, 0.9))?;
                put("vec_images", "image_key", "shot/", axis(2, 0.8))?;
                put("vec_images", "image_key", "doc/scan.pdf#2", axis(3, 0.75))?;
                put("vec_images", "image_key", "dim/", axis(4, 0.5))?;
                let mut query = vec![0.0_f32; EMBEDDING_DIMENSION];
                query[0] = 1.0;
                let on = note_hits(conn, &query, true);
                let off = note_hits(conn, &query, false);
                conn.execute_batch("DROP TABLE vec_images;")
                    .map_err(super::super::super::failed)?;
                Ok((on, off, note_hits(conn, &query, true)))
            })
            .expect("note hits");
        let ids = |hits: &[SemanticHit]| hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&on), ["text", "shot", "doc"]);
        assert!((on[1].cosine - 0.77).abs() < 1e-6);
        assert!((on[2].cosine - 0.72).abs() < 1e-6);
        assert_eq!(ids(&off), ["text"]);
        assert_eq!(
            ids(&broken),
            ["text"],
            "the image leg failing keeps the note hits"
        );
    }

    /// Real vec0 tables: a memo's best window answers for it through `note_hits`, and a broken
    /// voice table leaves the note hits (`semantic.ts:119-122`).
    #[cfg(feature = "vec")]
    #[test]
    fn note_hits_reads_voice_memo_windows() {
        use crate::domain::voice_embeddings::replace;
        use crate::storage::index_db::open_or_rebuild;
        use crate::storage::test_support::temp_dir;
        use crate::storage::vec::{EMBEDDING_DIMENSION, to_blob};

        let axis = |at: usize, weight: f32| {
            let mut vector = vec![0.0_f32; EMBEDDING_DIMENSION];
            vector[0] = weight;
            vector[at] = (1.0 - weight * weight).sqrt();
            vector
        };
        let dir = temp_dir("semantic-voice-hits");
        let opened = open_or_rebuild(&dir.path().join("index.db")).expect("open");
        let (found, broken) = opened
            .db
            .call_blocking(move |conn| {
                conn.execute(
                    "INSERT INTO vec_notes (note_id, embedding) VALUES ('n', ?1)",
                    [to_blob(&axis(1, 0.7))],
                )
                .map_err(super::super::super::failed)?;
                replace(
                    conn,
                    "memo",
                    VoiceSource::Audio,
                    &[axis(2, 0.1), axis(3, 0.9)],
                )?;
                let query = axis(4, 1.0);
                let found = note_hits(conn, &query, false);
                conn.execute_batch("DROP TABLE vec_voice;")
                    .map_err(super::super::super::failed)?;
                Ok((found, note_hits(conn, &query, false)))
            })
            .expect("note hits");
        let got: Vec<&str> = found.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(got, ["memo", "n"]);
        assert!((found[0].cosine - 0.87).abs() < 1e-6, "0.9 less the gap");
        let got: Vec<&str> = broken.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(got, ["n"]);
    }
}
