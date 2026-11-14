//! The semantic leg fused into the groups: `search-semantic.test.ts`.

use super::*;

/// `search-semantic.test.ts`: "finds a note that shares no keyword with the query".
#[test]
fn a_note_no_keyword_matches_is_found_by_its_vector() {
    let (data, index) = databases();
    note(&data, "felines", "Pet care", "felines.md", "markdown");
    reindex(&data, &index);
    assert_eq!(
        ids(&run(&data, &index, &query("cat"), &[]), SearchType::Note),
        Vec::<&str>::new()
    );

    let response = run(&data, &index, &query("cat"), &[("felines", 0.76)]);
    assert_eq!(ids(&response, SearchType::Note), ["felines"]);
    assert_eq!(response.total_count, 1);
    let item = &response.groups[0].results[0];
    assert_eq!(item.title, "Pet care");
    assert!(item.snippet.is_empty());
    assert_eq!(item.match_type, MatchType::Fuzzy);
    assert!((item.score - 0.76).abs() < 1e-12);
}

/// "lifts a note both legs found above one only FTS found".
#[test]
fn a_note_both_legs_found_rises_and_keeps_its_index_item() {
    let (data, index) = databases();
    note(&data, "a", "cat cat cat", "a.md", "markdown");
    note(
        &data,
        "b",
        "cat habits of the sleeping house cat",
        "b.md",
        "markdown",
    );
    reindex(&data, &index);
    let fts = run(&data, &index, &query("cat"), &[]);
    let order = ids(&fts, SearchType::Note);
    assert_eq!(order.len(), 2);
    let last = order[1].to_owned();
    let before = fts.groups[0].results[1].clone();

    let fused = run(&data, &index, &query("cat"), &[(&last, 0.8)]);
    assert_eq!(ids(&fused, SearchType::Note)[0], last);
    assert_eq!(
        fused.groups[0].results[0], before,
        "the index item, not the semantic one"
    );
    assert_eq!(fused.total_count, 2);
}

/// "keeps keyword matches ahead of semantic-only ones in cross-group scores".
#[test]
fn a_semantic_only_score_stays_under_a_keyword_match() {
    let (data, index) = databases();
    note(&data, "kw", "cat story", "kw.md", "markdown");
    note(&data, "sem", "Pet care", "sem.md", "markdown");
    reindex(&data, &index);
    let response = run(&data, &index, &query("cat"), &[("sem", 0.9)]);
    let score = |id: &str| {
        response.groups[0]
            .results
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.normalized_score)
            .expect(id)
    };
    assert!(score("sem") <= 0.5);
    assert!(score("kw") > score("sem"));
    assert!((score("sem") - (0.9 - 0.65) / 0.35 * 0.5).abs() < 1e-12);
}

/// "files journal hits under the journal group and honours the type filter".
#[test]
fn a_journal_vector_hit_joins_the_journal_group_in_type_order() {
    let (data, index) = databases();
    journal(&data, "day", "2026-02-01", "Kitten day");
    project(&data, "p", "P");
    task(&data, "t", "cat food", "p");
    reindex(&data, &index);
    let hits = [("day", 0.7)];
    let response = run(&data, &index, &query("cat"), &hits);
    assert_eq!(ids(&response, SearchType::Journal), ["day"]);
    assert_eq!(kinds(&response), [SearchType::Journal, SearchType::Task]);
    assert!(
        run(&data, &index, &of(&[SearchType::Note], "cat"), &hits)
            .groups
            .is_empty()
    );
}

/// "applies the folder filter to semantic-only hits", and the other filters too.
#[test]
fn every_filter_applies_to_semantic_only_hits() {
    let (data, index) = databases();
    note(&data, "in", "Pet care", "vault/in.md", "markdown");
    note(&data, "out", "Pet shop", "vault/out.md", "markdown");
    note(&data, "pic", "Pet photo", "vault/in-pic.png", "image");
    reindex(&data, &index);
    let hits = [("in", 0.8), ("out", 0.7), ("pic", 0.75)];

    let folder = GroupedQuery {
        folder_path: Some("vault/in".to_owned()),
        ..query("cat")
    };
    assert_eq!(
        ids(&run(&data, &index, &folder, &hits), SearchType::Note),
        ["in", "pic"]
    );

    let markdown = GroupedQuery {
        note_file_types: vec!["markdown".to_owned()],
        ..query("cat")
    };
    assert_eq!(
        ids(&run(&data, &index, &markdown, &hits), SearchType::Note),
        ["in", "out"]
    );

    let dated = GroupedQuery {
        filter: SearchFilter {
            modified: Some(ModifiedRange {
                from_ms: NOW * 2,
                to_ms: NOW * 3,
            }),
            ..SearchFilter::default()
        },
        ..query("cat")
    };
    assert!(run(&data, &index, &dated, &hits).groups.is_empty());

    let tasks_only = GroupedQuery {
        project_id: Some("p".to_owned()),
        ..query("cat")
    };
    assert!(run(&data, &index, &tasks_only, &hits).groups.is_empty());
}

#[test]
fn a_vector_hit_on_a_deleted_or_unknown_item_is_dropped() {
    let (data, index) = databases();
    note(&data, "gone", "Pet care", "gone.md", "markdown");
    reindex(&data, &index);
    data.execute(
        "UPDATE sync_items SET deleted_at = 1 WHERE item_id = 'gone'",
        [],
    )
    .expect("tombstone");
    let response = run(
        &data,
        &index,
        &query("cat"),
        &[("gone", 0.9), ("nobody", 0.9)],
    );
    assert!(response.groups.is_empty());
}

#[test]
fn the_group_holds_the_limit_after_fusion() {
    let (data, index) = databases();
    for at in 0..4 {
        note(
            &data,
            &format!("k{at}"),
            &format!("cat {at}"),
            &format!("k{at}.md"),
            "markdown",
        );
        note(
            &data,
            &format!("s{at}"),
            "Pet care",
            &format!("s{at}.md"),
            "markdown",
        );
    }
    reindex(&data, &index);
    let hits: Vec<(String, f64)> = (0..4).map(|at| (format!("s{at}"), 0.8)).collect();
    let hits: Vec<(&str, f64)> = hits.iter().map(|(id, c)| (id.as_str(), *c)).collect();
    let limited = GroupedQuery {
        limit: 5,
        ..query("cat")
    };
    let response = run(&data, &index, &limited, &hits);
    assert_eq!(ids(&response, SearchType::Note).len(), 5);
    assert_eq!(response.total_count, 5);
    // Equal RRF: the index's rank-0 item ties the semantic rank-0 item and wins on
    // order (`search-semantic-merge.ts:189`).
    let order = ids(&response, SearchType::Note);
    assert!(order[0].starts_with('k'));
    assert_eq!(order[1], "s0");
}

/// `search-semantic.test.ts` voice memos: "finds a memo that has no transcript".
#[test]
fn a_voice_memo_is_found_by_its_vector() {
    let (data, index) = databases();
    capture(
        &data,
        "applause",
        serde_json::json!({ "title": "Voice memo", "type": "voice" }),
    );
    reindex(&data, &index);
    assert!(
        run(&data, &index, &query("crowd cheering"), &[])
            .groups
            .is_empty()
    );

    let hits = [("applause", 0.74)];
    let response = run(&data, &index, &query("crowd cheering"), &hits);
    assert_eq!(ids(&response, SearchType::Inbox), ["applause"]);
    let item = &response.groups[0].results[0];
    assert_eq!(item.title, "Voice memo");
    assert!(matches!(&item.meta, ItemMeta::Inbox { item_type, .. } if item_type == "voice"));
    assert!(
        run(
            &data,
            &index,
            &of(&[SearchType::Note], "crowd cheering"),
            &hits
        )
        .groups
        .is_empty()
    );
}

/// "lifts a memo both legs found above one only FTS found".
#[test]
fn a_memo_both_legs_found_rises() {
    let (data, index) = databases();
    capture(
        &data,
        "a",
        serde_json::json!({ "title": "cat tax", "type": "voice", "transcription": "cat cat cat" }),
    );
    capture(
        &data,
        "b",
        serde_json::json!({ "title": "cat habits", "type": "voice", "transcription": "the cat sleeps" }),
    );
    reindex(&data, &index);
    let fts = run(&data, &index, &query("cat"), &[]);
    let order = ids(&fts, SearchType::Inbox);
    assert_eq!(order.len(), 2);
    let last = order[1].to_owned();
    let fused = run(&data, &index, &query("cat"), &[(&last, 0.8)]);
    assert_eq!(ids(&fused, SearchType::Inbox)[0], last);
    let index_item = fts.groups[0].results.iter().find(|item| item.id == last);
    assert_eq!(
        Some(&fused.groups[0].results[0]),
        index_item,
        "the index item, not the semantic one"
    );
}
