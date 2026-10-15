use std::collections::{HashMap, HashSet};

use crate::domain::notes::names::{js_trim, name_key};
use crate::domain::reads::NoteSummary;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WikiLinkCandidate {
    pub note_id: String,
    pub title: String,
    /// The name the query matched, `None` when it matched the title.
    pub matched_name: Option<String>,
    /// What a link to the note writes: its title, or its vault-root path stem
    /// (`Work/Plan`, `/Plan` at the root) when another note shares the title.
    pub link_target: String,
    /// The note's folder (`/` at the root) when another note shares the
    /// matched title or name, so the rows can be told apart.
    pub folder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WikiLinkCandidates {
    /// Best first, at most the limit asked for.
    pub candidates: Vec<WikiLinkCandidate>,
    /// A note's title or name equals the query by [`name_key`]. That note is
    /// the first candidate, and the menu offers no "Create note" row.
    pub exact: bool,
}

struct Entry<'a> {
    note: &'a NoteSummary,
    name: Option<&'a str>,
}

impl Entry<'_> {
    fn text(&self) -> &str {
        self.name.unwrap_or(&self.note.title)
    }
}

/// The `[[` menu's note rows for `query`, over `notes` in the order an empty
/// query lists them.
pub fn rank(query: &str, notes: &[NoteSummary], limit: usize) -> WikiLinkCandidates {
    let search = js_trim(query);
    let key = name_key(search);
    let entries: Vec<Entry> = notes
        .iter()
        .flat_map(|note| {
            let names = note.aliases.iter().map(|alias| Some(alias.as_str()));
            std::iter::once(None)
                .chain(names)
                .map(move |name| Entry { note, name })
        })
        .collect();
    let ranked: Vec<&Entry> = match &key {
        None => entries.iter().filter(|e| e.name.is_none()).collect(),
        Some(key) => {
            let exact = |title: bool| {
                entries.iter().filter(move |e| {
                    e.name.is_none() == title && name_key(e.text()).as_ref() == Some(key)
                })
            };
            exact(true)
                .chain(exact(false))
                .chain(fuzzy(&entries, search))
                .collect()
        }
    };

    let shared_titles = shared(notes.iter().map(|note| vec![note.title.to_lowercase()]));
    let shared_names = shared(
        notes
            .iter()
            .map(|note| note.aliases.iter().filter_map(|a| name_key(a)).collect()),
    );
    let mut seen = HashSet::new();
    let candidates: Vec<WikiLinkCandidate> = ranked
        .into_iter()
        .filter(|entry| seen.insert(&entry.note.id))
        .take(limit)
        .map(|entry| {
            let note = entry.note;
            let title_shared = shared_titles.contains(&note.title.to_lowercase());
            let row_shared = match entry.name {
                None => title_shared,
                Some(name) => name_key(name).is_some_and(|k| shared_names.contains(&k)),
            };
            WikiLinkCandidate {
                note_id: note.id.clone(),
                title: note.title.clone(),
                matched_name: entry.name.map(str::to_owned),
                link_target: if title_shared {
                    path_stem(note)
                } else {
                    note.title.clone()
                },
                folder: row_shared.then(|| note.folder_path.clone().unwrap_or("/".into())),
            }
        })
        .collect();
    let exact = key.is_some_and(|key| {
        candidates.first().is_some_and(|first| {
            name_key(first.matched_name.as_deref().unwrap_or(&first.title)) == Some(key)
        })
    });
    WikiLinkCandidates { candidates, exact }
}

fn shared(per_note: impl Iterator<Item = Vec<String>>) -> HashSet<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for keys in per_note {
        for key in keys.into_iter().collect::<HashSet<_>>() {
            *counts.entry(key).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .filter_map(|(key, count)| (count > 1).then_some(key))
        .collect()
}

fn path_stem(note: &NoteSummary) -> String {
    match note
        .folder_path
        .as_deref()
        .filter(|folder| !folder.is_empty())
    {
        Some(folder) => format!("{folder}/{}", note.title),
        None => format!("/{}", note.title),
    }
}

fn fuzzy<'a>(entries: &'a [Entry<'a>], query: &str) -> Vec<&'a Entry<'a>> {
    let query: Vec<u16> = query.to_lowercase().encode_utf16().collect();
    let mut scored: Vec<(i64, &Entry)> = entries
        .iter()
        .map(|entry| (score(entry.text(), &query), entry))
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    scored.into_iter().map(|(_, entry)| entry).collect()
}

fn score(text: &str, query: &[u16]) -> i64 {
    let text: Vec<u16> = text.to_lowercase().encode_utf16().collect();
    let (mut total, mut matched, mut run) = (0i64, 0usize, 0i64);
    for (at, &unit) in text.iter().enumerate() {
        if matched == query.len() {
            break;
        }
        if unit != query[matched] {
            run = 0;
            continue;
        }
        let word_start = at == 0 || matches!(text[at - 1], 0x20 | 0x2D | 0x5F);
        total += 100 - at as i64 + run * 10 + if word_start { 20 } else { 0 };
        run += 1;
        matched += 1;
    }
    if matched == query.len() { total } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, title: &str, folder: Option<&str>, aliases: &[&str]) -> NoteSummary {
        NoteSummary {
            id: id.into(),
            title: title.into(),
            folder_path: folder.map(str::to_owned),
            emoji: None,
            created_at: None,
            modified_at: None,
            aliases: aliases.iter().map(|a| (*a).to_owned()).collect(),
        }
    }

    fn row(
        id: &str,
        title: &str,
        name: Option<&str>,
        target: &str,
        folder: Option<&str>,
    ) -> WikiLinkCandidate {
        WikiLinkCandidate {
            note_id: id.into(),
            title: title.into(),
            matched_name: name.map(str::to_owned),
            link_target: target.into(),
            folder: folder.map(str::to_owned),
        }
    }

    fn vault() -> Vec<NoteSummary> {
        vec![
            note("n1", "Artificial Intelligence", None, &["AI", "Yapay Zeka"]),
            note("n2", "Reading list", Some("Books"), &[]),
        ]
    }

    #[test]
    fn a_title_match_is_a_title_row() {
        let ranked = rank("Reading", &vault(), 10);
        assert_eq!(
            ranked,
            WikiLinkCandidates {
                candidates: vec![row("n2", "Reading list", None, "Reading list", None)],
                exact: false,
            }
        );
    }

    #[test]
    fn an_exact_name_match_leads_as_a_name_row_and_is_exact() {
        let ranked = rank("ai", &vault(), 10);
        assert_eq!(
            ranked,
            WikiLinkCandidates {
                candidates: vec![
                    row(
                        "n1",
                        "Artificial Intelligence",
                        Some("AI"),
                        "Artificial Intelligence",
                        None
                    ),
                    row("n2", "Reading list", None, "Reading list", None),
                ],
                exact: true,
            }
        );
    }

    #[test]
    fn a_fuzzy_name_match_names_the_name() {
        let ranked = rank("yapay", &vault(), 10);
        assert_eq!(
            ranked.candidates,
            vec![row(
                "n1",
                "Artificial Intelligence",
                Some("Yapay Zeka"),
                "Artificial Intelligence",
                None
            )]
        );
        assert!(!ranked.exact);
    }

    #[test]
    fn an_exact_title_beats_an_exact_name() {
        let notes = vec![
            note("n1", "Plan", None, &["Roadmap"]),
            note("n2", "Roadmap", None, &[]),
        ];
        let ranked = rank("roadmap", &notes, 10);
        assert_eq!(
            ranked.candidates,
            vec![
                row("n2", "Roadmap", None, "Roadmap", None),
                row("n1", "Plan", Some("Roadmap"), "Plan", None),
            ]
        );
        assert!(ranked.exact);
    }

    #[test]
    fn a_shared_title_links_by_path_and_shows_its_folder() {
        let notes = vec![
            note("n1", "Plan", Some("Work"), &[]),
            note("n2", "plan", None, &[]),
        ];
        assert_eq!(
            rank("plan", &notes, 10).candidates,
            vec![
                row("n1", "Plan", None, "Work/Plan", Some("Work")),
                row("n2", "plan", None, "/plan", Some("/")),
            ]
        );
    }

    #[test]
    fn a_shared_name_is_two_rows_with_their_folders() {
        let notes = vec![
            note("n1", "Machine Learning", Some("Tech"), &["ML"]),
            note("n2", "Markup Language", None, &["ml"]),
        ];
        assert_eq!(
            rank("ML", &notes, 10).candidates,
            vec![
                row(
                    "n1",
                    "Machine Learning",
                    Some("ML"),
                    "Machine Learning",
                    Some("Tech")
                ),
                row(
                    "n2",
                    "Markup Language",
                    Some("ml"),
                    "Markup Language",
                    Some("/")
                ),
            ]
        );
    }

    #[test]
    fn an_empty_query_lists_titles_in_order_up_to_the_limit() {
        let ranked = rank("  ", &vault(), 1);
        assert_eq!(
            ranked,
            WikiLinkCandidates {
                candidates: vec![row(
                    "n1",
                    "Artificial Intelligence",
                    None,
                    "Artificial Intelligence",
                    None
                )],
                exact: false,
            }
        );
    }

    #[test]
    fn fuzzy_scores_as_desktop_does() {
        let query: Vec<u16> = "rl".encode_utf16().collect();
        assert_eq!(score("Reading list", &query), 232);
        assert_eq!(score("Plan", &query), 0);
    }
}
