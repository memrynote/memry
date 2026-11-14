//! What one search costs and what it survives: the index asks a filter makes, the
//! lookups an index hit skips, and the queries and failures that answer rather than
//! error (`search.ts:553-680`).

use super::*;

fn notes(data: &Connection, count: usize, title: &str, file_type: &str) {
    for at in 0..count {
        note(
            data,
            &format!("{file_type}{at}"),
            title,
            &format!("{file_type}{at}.{file_type}"),
            file_type,
        );
    }
}

/// A project filter keeps tasks only, so the other types never reach the index.
#[test]
fn a_project_filter_asks_the_task_index_once() {
    let (data, index) = databases();
    notes(&data, 200, "Budget", "markdown");
    project(&data, "a", "Alpha");
    task(&data, "ta", "Budget task", "a");
    reindex(&data, &index);
    let project = GroupedQuery {
        project_id: Some("a".to_owned()),
        limit: 1,
        ..query("budget")
    };

    let (response, statements) = index_statements(&index, || run(&data, &index, &project, &[]));

    assert_eq!(ids(&response, SearchType::Task), ["ta"]);
    assert_eq!(kinds(&response), [SearchType::Task]);
    assert_eq!(index_asks(&statements), 1);
}

/// `search.ts:93-101,120`: the file type filter narrows the index query itself, so
/// a type no note has is answered by one ask.
#[test]
fn a_file_type_no_hit_has_asks_the_index_once() {
    let (data, index) = databases();
    notes(&data, 200, "Budget", "markdown");
    reindex(&data, &index);
    let images = GroupedQuery {
        note_file_types: vec!["image".to_owned()],
        limit: 1,
        ..of(&[SearchType::Note], "budget")
    };

    let (response, statements) = index_statements(&index, || run(&data, &index, &images, &[]));

    assert!(response.groups.is_empty());
    assert_eq!(index_asks(&statements), 1);
}

/// Markdown first may ask again, at most [`MAX_ASKS`] times, however many filed
/// files out-rank the first markdown note.
#[test]
fn markdown_first_asks_a_bounded_number_of_times() {
    let (data, index) = databases();
    notes(&data, 100, "Ledger ledger ledger", "image");
    note(
        &data,
        "md",
        "Ledger and other words in a long title",
        "md.md",
        "markdown",
    );
    reindex(&data, &index);
    let one = GroupedQuery {
        limit: 1,
        ..of(&[SearchType::Note], "ledger")
    };

    let (response, statements) = index_statements(&index, || run(&data, &index, &one, &[]));

    assert_eq!(ids(&response, SearchType::Note).len(), 1);
    assert!(index_asks(&statements) <= MAX_ASKS);
}

/// `search.test.ts:320`: "filters fuzzy fallback candidates by note file type too".
#[test]
fn the_file_type_filter_narrows_the_fuzzy_candidates() {
    let (data, index) = databases();
    notes(&data, 5, "Receipt", "image");
    note(
        &data,
        "md",
        "Receipt scans and other receipt notes",
        "md.md",
        "markdown",
    );
    reindex(&data, &index);
    let markdown = GroupedQuery {
        note_file_types: vec!["markdown".to_owned()],
        limit: 1,
        ..of(&[SearchType::Note], "recpt")
    };
    let response = run(&data, &index, &markdown, &[]);
    assert_eq!(ids(&response, SearchType::Note), ["md"]);
    assert_eq!(response.groups[0].results[0].match_type, MatchType::Fuzzy);
}

/// Index hits carry their title, so `fts_notes` (whose `id` is unindexed) is never
/// scanned by id; a semantic-only journal day takes its title from `data.db`.
#[test]
fn no_item_reads_its_title_from_the_index_by_id() {
    let (data, index) = databases();
    note(&data, "n1", "Invoice plan", "n1.md", "markdown");
    journal(&data, "j1", "2026-01-01", "Invoice day");
    journal(&data, "j2", "2026-01-02", "Kitten day");
    reindex(&data, &index);

    let (response, statements) = index_statements(&index, || {
        run(
            &data,
            &index,
            &query("invoice"),
            &[("j2", 0.8), ("n1", 0.7)],
        )
    });

    assert_eq!(ids(&response, SearchType::Note), ["n1"]);
    assert_eq!(ids(&response, SearchType::Journal), ["j1", "j2"]);
    let titles: Vec<&str> = response.groups[1]
        .results
        .iter()
        .map(|item| item.title.as_str())
        .collect();
    assert_eq!(titles, ["Invoice day", "Kitten day"]);
    let by_id: Vec<&String> = statements
        .iter()
        .filter(|sql| sql.contains("FROM fts_notes WHERE id"))
        .collect();
    assert!(by_id.is_empty(), "{by_id:?}");
}

/// `truncateQuery` (`search.ts:554`): 300 `NOT`s would build an expression FTS5
/// rejects as too deep.
#[test]
fn a_query_of_three_hundred_nots_answers() {
    let (data, index) = databases();
    note(&data, "n1", "alpha", "n1.md", "markdown");
    reindex(&data, &index);
    let text = format!("alpha {}", "NOT beta ".repeat(300));
    let response = search_all(&data, &index, &query(&text), &[]);
    assert_eq!(ids(&response, SearchType::Note), ["n1"]);
}

#[test]
fn a_ten_thousand_character_query_answers() {
    let (data, index) = databases();
    note(&data, "n1", "alpha", "n1.md", "markdown");
    reindex(&data, &index);
    let text = "alpha ".repeat(2_000);
    assert_eq!(
        ids(
            &search_all(&data, &index, &query(&text), &[]),
            SearchType::Note
        ),
        ["n1"]
    );
    let unbroken = "é".repeat(10_000);
    assert!(
        search_all(&data, &index, &query(&unbroken), &[])
            .groups
            .is_empty()
    );
}

/// `search.ts:588-591`: one type failing leaves the other groups.
#[test]
fn a_failing_type_keeps_the_other_groups() {
    let (data, index) = databases();
    note(&data, "n1", "Invoice plan", "n1.md", "markdown");
    capture(
        &data,
        "i1",
        serde_json::json!({ "title": "Invoice link", "type": "link" }),
    );
    reindex(&data, &index);
    data.execute_batch("DROP VIEW inbox_view; DROP TABLE inbox_items;")
        .expect("break the inbox");

    let response = run(&data, &index, &query("invoice"), &[]);

    assert_eq!(kinds(&response), [SearchType::Note]);
    assert_eq!(response.total_count, 1);
}

/// `search.ts:675-677`: a failing semantic merge answers from the index.
#[test]
fn a_failing_semantic_leg_keeps_the_index_groups() {
    let (data, index) = databases();
    note(&data, "n1", "Invoice plan", "n1.md", "markdown");
    journal(&data, "j1", "2026-01-01", "Kitten day");
    reindex(&data, &index);
    data.execute(
        "UPDATE sync_items SET payload = 'not a payload' WHERE item_id = 'j1'",
        [],
    )
    .expect("break the journal payload");

    let response = run(
        &data,
        &index,
        &of(&[SearchType::Note], "invoice"),
        &[("j1", 0.9)],
    );

    assert_eq!(ids(&response, SearchType::Note), ["n1"]);
    assert_eq!(response.total_count, 1);
}

/// `search.ts:557-559`: no searchable term answers nothing, semantic hits included.
#[test]
fn no_searchable_term_fuses_nothing() {
    let (data, index) = databases();
    note(&data, "n1", "Pet care", "n1.md", "markdown");
    reindex(&data, &index);
    assert_eq!(
        run(&data, &index, &query("  "), &[("n1", 0.9)]),
        GroupedResponse::default()
    );
}
