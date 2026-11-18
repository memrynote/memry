//! `getSuggestions`' assembly rules (`suggestions.ts:699-818`). The scorer's
//! numbers are pinned by the oracle vectors (`tests/inbox_suggest_vectors.rs`).

use super::*;

fn item(item_type: &str, title: &str, content: Option<&str>, tags: &[&str]) -> InboxItem {
    InboxItem {
        id: "item-1".to_owned(),
        item_type: item_type.to_owned(),
        title: title.to_owned(),
        content: content.map(str::to_owned),
        metadata: None,
        filed_at: None,
        filed_to: None,
        filed_action: None,
        snoozed_until: None,
        snooze_reason: None,
        archived_at: None,
        viewed_at: None,
        source_url: None,
        source_title: None,
        capture_source: None,
        processing_status: None,
        transcription: None,
        transcription_status: None,
        attachment_path: None,
        thumbnail_path: None,
        attachment_id: None,
        created_at: 0,
        modified_at: None,
        tags: tags.iter().map(|t| (*t).to_owned()).collect(),
    }
}

fn hit(id: &str, path: &str, distance: f64) -> SuggestHit {
    SuggestHit {
        note_id: id.to_owned(),
        path: path.to_owned(),
        title: format!("Title {id}"),
        emoji: None,
        snippet: Some(format!("snippet of {id}")),
        distance,
    }
}

fn pattern(destination: &str, action: &str, count: i64, tags: &[&str]) -> FilingPattern {
    FilingPattern {
        destination: destination.to_owned(),
        action: action.to_owned(),
        count,
        tags: tags.iter().map(|t| (*t).to_owned()).collect(),
    }
}

fn long_item() -> InboxItem {
    item(
        "note",
        "Pasta night",
        Some("a long enough note about dinner"),
        &[],
    )
}

fn kinds(found: &[Suggestion]) -> Vec<(String, String)> {
    found
        .iter()
        .map(|s| {
            let target = s
                .path
                .clone()
                .or_else(|| s.note_id.clone())
                .unwrap_or_default();
            (s.destination_type.clone(), target)
        })
        .collect()
}

/// `findSimilarNotes:363`: `distance <= MAX_DISTANCE_THRESHOLD`.
#[test]
fn a_neighbour_past_the_distance_cutoff_is_dropped() {
    let index = SuggestIndex {
        hits: vec![
            hit("in", "food/in.md", 0.25),
            hit("out", "food/out.md", 0.2501),
        ],
        ..SuggestIndex::default()
    };
    let found = assemble(&long_item(), &index, &FilingHistory::default());
    let notes: Vec<_> = found.iter().filter_map(|s| s.note_id.clone()).collect();
    assert_eq!(notes, ["in"]);
}

/// `suggestions.ts:723`: the index signals need 10 UTF-16 units of input;
/// the history fallbacks do not.
#[test]
fn a_short_capture_gets_only_history_suggestions() {
    let index = SuggestIndex {
        hits: vec![hit("a", "food/a.md", 0.0)],
        folders: vec!["food".to_owned()],
        ..SuggestIndex::default()
    };
    let history = FilingHistory {
        patterns: vec![pattern("recipes", "folder", 2, &["cooking"])],
        recent: Vec::new(),
    };
    let found = assemble(&item("note", "food", None, &[]), &index, &history);
    assert_eq!(kinds(&found), [("folder".to_owned(), "recipes".to_owned())]);
    assert_eq!(found[0].reason, "You've filed 2 similar notes here");
    assert_eq!(found[0].suggested_tags, ["cooking"]);
    assert!((found[0].confidence - 0.5).abs() < 1e-12);
}

/// `suggestions.ts:762-777`: at most three notes, best first, with the
/// rounded match, the first 150 UTF-16 units of the snippet and the emoji.
#[test]
fn note_suggestions_are_the_three_best_neighbours() {
    let mut close = hit("close", "a/close.md", 0.04);
    close.emoji = Some("🍝".to_owned());
    close.snippet = Some("é".repeat(149) + "😀tail");
    let index = SuggestIndex {
        hits: vec![
            hit("far", "a/far.md", 0.2),
            close,
            hit("mid", "a/mid.md", 0.1),
            hit("fourth", "a/fourth.md", 0.01),
        ],
        ..SuggestIndex::default()
    };
    let found = assemble(&long_item(), &index, &FilingHistory::default());
    let notes: Vec<_> = found
        .iter()
        .filter(|s| s.destination_type == "note")
        .collect();
    // The first three neighbours in KNN order, then sorted by confidence.
    let ids: Vec<_> = notes.iter().filter_map(|s| s.note_id.as_deref()).collect();
    assert_eq!(ids, ["close", "mid", "far"]);
    // calibrate(0.96) = 0.9: 90%.
    assert_eq!(notes[0].reason, "Similar content (90% match)");
    let note = notes[0].suggested_note.as_ref().expect("the note");
    assert_eq!(note.emoji.as_deref(), Some("🍝"));
    // 149 units of é, then the first half of the emoji's surrogate pair.
    assert_eq!(note.snippet, "é".repeat(149) + "\u{FFFD}");
    assert_eq!(notes[0].note_title.as_deref(), Some("Title close"));
}

/// `findSimilarNotes(content, SIMILAR_NOTE_LIMIT)`: only the KNN's 20 count.
#[test]
fn only_the_first_twenty_neighbours_are_read() {
    let mut hits: Vec<_> = (0..20)
        .map(|i| hit(&format!("n{i}"), "a/x.md", 0.3))
        .collect();
    hits.push(hit("late", "b/late.md", 0.0));
    let index = SuggestIndex {
        hits,
        ..SuggestIndex::default()
    };
    assert!(assemble(&long_item(), &index, &FilingHistory::default()).is_empty());
}

/// `suggestions.ts:742,747-756`: folders under 0.45 are dropped; the reason
/// names the closest note.
#[test]
fn folder_suggestions_need_the_folder_floor() {
    let index = SuggestIndex {
        // Three notes at calibrated 0.9 in `food`; one at 0.2 in `misc`.
        hits: vec![
            hit("a", "food/a.md", 0.04),
            hit("b", "food/b.md", 0.04),
            hit("c", "food/c.md", 0.04),
            hit("d", "misc/d.md", 0.24),
        ],
        ..SuggestIndex::default()
    };
    let found = assemble(&long_item(), &index, &FilingHistory::default());
    let folders: Vec<_> = found
        .iter()
        .filter(|s| s.destination_type == "folder")
        .collect();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].path.as_deref(), Some("food"));
    assert_eq!(folders[0].reason, "Similar to \"Title a\" in food");
}

/// `collectFolderFallbacks`: history first, then recents, skipping folders
/// already suggested, until three folders; history keeps its action.
#[test]
fn the_fallback_ladder_fills_the_folder_slots() {
    let history = FilingHistory {
        patterns: vec![
            pattern("work", "folder", 5, &[]),
            pattern("", "task", 1, &[]),
            pattern("work", "note", 1, &[]),
        ],
        recent: vec![("home".to_owned(), 3), ("later".to_owned(), 9)],
    };
    let found = assemble(
        &item("link", "x", None, &[]),
        &SuggestIndex::default(),
        &history,
    );
    // Sorted by confidence: 0.7, 0.4, 0.35; `later` found no slot.
    assert_eq!(
        kinds(&found),
        [
            ("folder".to_owned(), "work".to_owned()),
            ("task".to_owned(), String::new()),
            ("folder".to_owned(), "home".to_owned()),
        ]
    );
    assert_eq!(found[0].reason, "You've filed 5 similar links here");
    assert!((found[0].confidence - 0.7).abs() < 1e-12);
    assert_eq!(found[2].reason, "Recently used (3 items)");
    assert!((found[2].confidence - 0.35).abs() < 1e-12);
}

/// `suggestions.ts:747-749`: an index suggestion of the root is remembered as
/// `root`, so a history pattern for `""` is still offered (Electron's keys).
#[test]
fn a_root_folder_suggestion_does_not_hide_a_root_pattern() {
    let index = SuggestIndex {
        hits: vec![
            hit("a", "a.md", 0.0),
            hit("b", "b.md", 0.0),
            hit("c", "c.md", 0.0),
        ],
        ..SuggestIndex::default()
    };
    let history = FilingHistory {
        patterns: vec![pattern("", "folder", 1, &[])],
        recent: Vec::new(),
    };
    let found = assemble(&long_item(), &index, &history);
    let roots = found
        .iter()
        .filter(|s| s.destination_type == "folder" && s.path.as_deref() == Some(""))
        .count();
    assert_eq!(roots, 2);
    assert_eq!(found[0].reason, "Similar to \"Title a\" in root");
}

/// `suggestions.ts:806-813`: folder suggestions sorted together, cut to three,
/// then the notes.
#[test]
fn folders_sort_together_before_the_notes() {
    let index = SuggestIndex {
        hits: vec![
            hit("a", "food/a.md", 0.24),
            hit("b", "food/b.md", 0.24),
            hit("c", "food/c.md", 0.24),
        ],
        folders: vec!["dinner".to_owned()],
        ..SuggestIndex::default()
    };
    let history = FilingHistory {
        patterns: vec![pattern("work", "folder", 9, &[])],
        recent: Vec::new(),
    };
    let found = assemble(&long_item(), &index, &history);
    let order: Vec<_> = kinds(&found).into_iter().map(|(_, t)| t).collect();
    // `dinner` by name (1.0), history 0.7, then the notes; `food` is under the
    // floor (calibrated 0.4, corroborated 0.36).
    assert_eq!(order, ["dinner", "work", "a", "b", "c"]);
    assert_eq!(found[0].reason, "Folder name matches \"dinner\"");
}

/// `computeTagMatches`: tags compare folded; the share is over the capture's
/// distinct tags.
#[test]
fn tag_matches_fold_and_share() {
    let tagged = vec![
        TaggedNote {
            path: "kitchen/a.md".to_owned(),
            tag: "COOKING".to_owned(),
        },
        TaggedNote {
            path: "kitchen/b.md".to_owned(),
            tag: "cooking".to_owned(),
        },
        TaggedNote {
            path: "garden/c.md".to_owned(),
            tag: "weeds".to_owned(),
        },
    ];
    let item_tags = [
        "Cooking".to_owned(),
        "cooking".to_owned(),
        "travel".to_owned(),
    ];
    assert_eq!(
        tag_matches(&item_tags, &tagged),
        [("kitchen".to_owned(), 0.5)]
    );
}

/// `computeNameMatches` over `tokenize`: lowercase ASCII words of two or more
/// characters; the root is skipped.
#[test]
fn name_matches_count_folder_tokens() {
    let tokens = tokenize("Weekly REVIEW for project-x, café");
    assert_eq!(tokens, ["weekly", "review", "for", "project", "caf"]);
    let folders = vec![
        String::new(),
        "work/weekly-review".to_owned(),
        "project/x".to_owned(),
        "misc".to_owned(),
    ];
    assert_eq!(
        name_matches(&folders, &tokens),
        [
            ("work/weekly-review".to_owned(), 2.0 / 3.0),
            ("project/x".to_owned(), 1.0),
        ]
    );
}

/// `folderReason` for each dominant signal.
#[test]
fn folder_reasons_name_the_dominant_signal() {
    let score = |path: &str, name: f64, tag: f64| FolderScore {
        path: path.to_owned(),
        confidence: 0.5,
        support: 0,
        top_note_title: None,
        sim: 0.0,
        name,
        tag,
    };
    assert_eq!(
        folder_reason(&score("", 1.0, 0.0)),
        "Matches the root folder"
    );
    assert_eq!(
        folder_reason(&score("a", 0.0, 1.0)),
        "Shared tags with notes in a"
    );
    assert_eq!(
        folder_reason(&score("", 0.0, 1.0)),
        "Shared tags with root notes"
    );
    assert_eq!(folder_reason(&score("a", 0.0, 0.0)), "Suggested folder a");
    assert_eq!(folder_reason(&score("", 0.0, 0.0)), "Root folder");
}
