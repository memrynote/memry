//! Electron's `similarity/index.test.ts`, case for case, over an in-memory store whose
//! `nearest` is the exact cosine search `vec_note_similar` answers.

use super::*;
use crate::domain::similarity::scoring::cosine_similarity;

struct Note {
    id: String,
    info: NoteInfo,
    vector: Option<Vec<f32>>,
    tags: Vec<String>,
}

#[derive(Default)]
struct Store {
    ai_enabled: Option<String>,
    notes: Vec<Note>,
    links: Vec<(String, String)>,
    /// Notes whose vector is still stored after the note is gone.
    pruned: Vec<String>,
}

impl Store {
    fn add(&mut self, id: &str, path: &str, vector: Option<&[f32]>, tags: &[&str]) {
        let info = NoteInfo {
            title: id.to_owned(),
            path: path.to_owned(),
            emoji: None,
            snippet: None,
        };
        self.notes.push(Note {
            id: id.to_owned(),
            info,
            vector: vector.map(<[f32]>::to_vec),
            tags: tags.iter().map(|t| (*t).to_owned()).collect(),
        });
    }
}

impl SimilarityStore for Store {
    fn ai_enabled_setting(&self) -> Result<Option<String>, StorageError> {
        Ok(self.ai_enabled.clone())
    }

    fn vector(&self, note_id: &str) -> Result<Option<Vec<f32>>, StorageError> {
        Ok(self
            .notes
            .iter()
            .find(|n| n.id == note_id)
            .and_then(|n| n.vector.clone()))
    }

    fn nearest(&self, vector: &[f32], k: usize) -> Result<Vec<(String, f64)>, StorageError> {
        let mut hits: Vec<(String, f64)> = self
            .notes
            .iter()
            .filter_map(|n| {
                let distance = 1.0 - cosine_similarity(vector, n.vector.as_deref()?);
                Some((n.id.clone(), distance))
            })
            .collect();
        hits.sort_by(|a, b| a.1.total_cmp(&b.1));
        hits.truncate(k);
        Ok(hits)
    }

    fn linked_note_ids(&self, note_id: &str) -> Result<HashSet<String>, StorageError> {
        Ok(self
            .links
            .iter()
            .filter_map(|(from, to)| match () {
                () if from == note_id => Some(to.clone()),
                () if to == note_id => Some(from.clone()),
                () => None,
            })
            .collect())
    }

    fn tags_by_note(
        &self,
        note_ids: &[String],
    ) -> Result<HashMap<String, Vec<String>>, StorageError> {
        Ok(self
            .notes
            .iter()
            .filter(|n| note_ids.contains(&n.id) && !n.tags.is_empty())
            .map(|n| (n.id.clone(), n.tags.clone()))
            .collect())
    }

    fn notes(&self, note_ids: &[String]) -> Result<HashMap<String, NoteInfo>, StorageError> {
        Ok(self
            .notes
            .iter()
            .filter(|n| note_ids.contains(&n.id) && !self.pruned.contains(&n.id))
            .map(|n| (n.id.clone(), n.info.clone()))
            .collect())
    }
}

fn ids(notes: &SimilarNotes) -> Vec<&str> {
    notes.notes.iter().map(|n| n.id.as_str()).collect()
}

#[test]
fn similar_notes_are_nearest_first_without_the_note_itself() {
    let mut store = Store::default();
    store.add("source", "sleep/source.md", Some(&[1.0, 0.0, 0.0]), &[]);
    store.add("close", "sleep/close.md", Some(&[0.95, 0.1, 0.0]), &[]);
    store.add("closer", "sleep/closer.md", Some(&[0.99, 0.05, 0.0]), &[]);
    store.add(
        "unrelated",
        "code/unrelated.md",
        Some(&[0.0, 0.0, 1.0]),
        &[],
    );

    let result = similar_notes(&store, "source", 5).unwrap();

    assert_eq!(result.status, SimilarityStatus::Ready);
    assert_eq!(ids(&result), ["closer", "close"]);
    assert_eq!(result.notes[0].info.path, "sleep/closer.md");
}

#[test]
fn similar_notes_exclude_notes_already_linked_either_way() {
    let mut store = Store::default();
    store.add("source", "a/source.md", Some(&[1.0, 0.0, 0.0]), &[]);
    store.add("outgoing", "a/outgoing.md", Some(&[0.99, 0.01, 0.0]), &[]);
    store.add("incoming", "a/incoming.md", Some(&[0.98, 0.02, 0.0]), &[]);
    store.add("free", "a/free.md", Some(&[0.97, 0.03, 0.0]), &[]);
    store.links = vec![
        ("source".into(), "outgoing".into()),
        ("incoming".into(), "source".into()),
    ];

    // A limit of one still reaches `free`: the search over-fetches by the excluded count.
    assert_eq!(ids(&similar_notes(&store, "source", 1).unwrap()), ["free"]);
}

#[test]
fn similar_notes_skip_a_vector_that_outlived_its_note() {
    let mut store = Store::default();
    store.add("source", "a/source.md", Some(&[1.0, 0.0, 0.0]), &[]);
    store.add("gone", "a/gone.md", Some(&[0.99, 0.01, 0.0]), &[]);
    store.add("kept", "a/kept.md", Some(&[0.98, 0.02, 0.0]), &[]);
    store.pruned = vec!["gone".into()];

    assert_eq!(ids(&similar_notes(&store, "source", 5).unwrap()), ["kept"]);
}

#[test]
fn similar_notes_report_why_they_are_empty() {
    let mut store = Store::default();
    store.add("unembedded", "a/unembedded.md", None, &[]);
    assert_eq!(
        similar_notes(&store, "unembedded", DEFAULT_SIMILAR_LIMIT)
            .unwrap()
            .status,
        SimilarityStatus::NoEmbedding
    );

    store.ai_enabled = Some("false".into());
    assert_eq!(
        similar_notes(&store, "unembedded", DEFAULT_SIMILAR_LIMIT).unwrap(),
        SimilarNotes {
            status: SimilarityStatus::Disabled,
            notes: Vec::new(),
        }
    );
}

#[test]
fn tag_suggestions_are_tags_several_neighbours_share_and_the_note_lacks() {
    let mut store = Store::default();
    store.add("source", "a/source.md", Some(&[1.0, 0.0, 0.0]), &["mine"]);
    store.add("n1", "a/n1.md", Some(&[0.95, 0.1, 0.0]), &["sleep", "mine"]);
    store.add("n2", "a/n2.md", Some(&[0.9, 0.2, 0.0]), &["sleep"]);
    store.add("n3", "a/n3.md", Some(&[0.9, 0.1, 0.1]), &["once"]);

    let result = tag_suggestions(&store, "source").unwrap();

    assert_eq!(result.status, SimilarityStatus::Ready);
    let tags: Vec<_> = result
        .tags
        .iter()
        .map(|t| (t.tag.as_str(), t.support))
        .collect();
    assert_eq!(tags, [("sleep", 2)]);
}

#[test]
fn groups_by_similarity_names_from_shared_tags_and_reports_missing_vectors() {
    let mut store = Store::default();
    store.add("s1", "health/s1.md", Some(&[1.0, 0.1, 0.0]), &["sleep"]);
    store.add("s2", "health/s2.md", Some(&[0.9, 0.2, 0.0]), &["sleep"]);
    store.add("c1", "code/c1.md", Some(&[0.0, 1.0, 0.1]), &[]);
    store.add("c2", "code/c2.md", Some(&[0.1, 1.0, 0.0]), &[]);
    store.add("lonely", "x/lonely.md", Some(&[0.0, 0.0, 1.0]), &[]);
    store.add("empty", "x/empty.md", None, &[]);

    let request: Vec<String> = ["s1", "c1", "s2", "c2", "lonely", "empty", "s1"]
        .map(String::from)
        .to_vec();
    let result = group_notes(&store, &request).unwrap();

    let group = |ids: [&str; 2], name: &str| NoteGroup {
        note_ids: ids.map(String::from).to_vec(),
        titles: ids.map(String::from).to_vec(),
        suggested_name: Some(name.to_owned()),
    };
    assert_eq!(
        result,
        NoteGroups {
            status: SimilarityStatus::Ready,
            groups: vec![group(["s1", "s2"], "sleep"), group(["c1", "c2"], "code")],
            ungrouped: vec!["lonely".into()],
            missing: vec!["empty".into()],
        }
    );
}

#[test]
fn grouping_is_off_with_ai_and_capped_at_the_request_limit() {
    let mut store = Store::default();
    let request: Vec<String> = (0..MAX_CLUSTER_NOTES + 5)
        .map(|i| format!("n{i}"))
        .collect();
    for id in &request {
        store.add(id, &format!("{id}.md"), None, &[]);
    }
    assert_eq!(
        group_notes(&store, &request).unwrap().missing.len(),
        MAX_CLUSTER_NOTES
    );

    store.ai_enabled = Some("false".into());
    let off = group_notes(&store, &request).unwrap();
    assert_eq!(off.status, SimilarityStatus::Disabled);
    assert!(off.missing.is_empty());
}

#[test]
fn calibration_maps_the_floor_to_0_and_clamps() {
    assert_eq!(calibrate_similarity(0.6), 0.0);
    assert_eq!(calibrate_similarity(0.2), 0.0);
    assert!((calibrate_similarity(0.8) - 0.5).abs() < 1e-12);
    assert_eq!(calibrate_similarity(1.2), 1.0);
}
