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
//! The image and voice legs (`semantic.ts:85-122`) join here when their vector
//! stores land (Steps 24 and 25); their floors are 0.68, shifted down by 0.03.

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

/// Merges the nearest head windows (`notes`, by note id) and later windows
/// (`chunks`, by `<note_id>#<n>`), each with its cosine distance, into one hit per
/// note at its best cosine; drops those under the floor; best first, at most
/// [`NEIGHBOURS`] (`semantic.ts:66-84,100-104`). Ties keep the order seen.
pub fn best_windows(
    notes: impl IntoIterator<Item = (String, f64)>,
    chunks: impl IntoIterator<Item = (String, f64)>,
) -> Vec<SemanticHit> {
    let mut hits: Vec<SemanticHit> = Vec::new();
    let mut consider = |id: &str, cosine: f64| match hits.iter_mut().find(|hit| hit.id == id) {
        Some(hit) => hit.cosine = hit.cosine.max(cosine),
        None => hits.push(SemanticHit {
            id: id.to_owned(),
            cosine,
        }),
    };
    for (id, distance) in notes {
        consider(&id, 1.0 - distance);
    }
    for (id, distance) in chunks {
        let note = id.rsplit_once('#').map_or(id.as_str(), |(note, _)| note);
        consider(note, 1.0 - distance);
    }
    hits.retain(|hit| hit.cosine >= QUERY_SIMILARITY_FLOOR);
    hits.sort_by(|a, b| b.cosine.total_cmp(&a.cosine));
    hits.truncate(NEIGHBOURS);
    hits
}

/// The notes and journal days nearest `query` (an embedded search query), best
/// first: the [`NEIGHBOURS`] nearest of `vec_notes` and of `vec_note_chunks`, merged
/// by [`best_windows`].
#[cfg(feature = "vec")]
pub fn note_hits(
    index: &rusqlite::Connection,
    query: &[f32],
) -> Result<Vec<SemanticHit>, crate::api::errors::StorageError> {
    use crate::storage::vec::{VecTable, nearest};
    Ok(best_windows(
        nearest(index, VecTable::Notes, query, NEIGHBOURS)?,
        nearest(index, VecTable::NoteChunks, query, NEIGHBOURS)?,
    ))
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
        let hits = best_windows(notes, Vec::new());
        assert_eq!(hits.len(), 30);
        assert_eq!(hits[0], hit("n0", 0.9));
        assert_eq!(hits[29].id, "n29");
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
                note_hits(conn, &query)
            })
            .expect("note hits");
        let got: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(got, ["chunked", "near"]);
        assert!((hits[0].cosine - 0.95).abs() < 1e-6);
        assert!((hits[1].cosine - 0.9).abs() < 1e-6);
    }
}
