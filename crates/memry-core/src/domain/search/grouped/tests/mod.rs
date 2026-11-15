//! Desktop's grouped search over real SQLite and FTS5, cases ported from
//! `apps/desktop/src/main/database/queries/search.test.ts` and
//! `search-semantic.test.ts`. Semantic hits are given, as `searchAll` takes them.

use std::cell::RefCell;

use rusqlite::trace::{TraceEvent, TraceEventCodes};
use rusqlite::{Connection, params};

use super::*;
use crate::domain::search::{self, ModifiedRange};
use crate::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use crate::storage::pragmas::{self, Profile};
use crate::storage::repositories::sync_items::{self, InboundRecord};

mod bounds;
mod fusion;

const NOW: i64 = 1_760_000_000_000;

fn databases() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    // `tag_fold` and the other functions the tag and date filters call.
    pragmas::configure_writer(&data, Profile::Data).expect("data functions");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    (data, index)
}

fn put(data: &Connection, item_type: &str, id: &str, payload: serde_json::Value) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-a".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    sync_items::apply_remote(data, &record, NOW).expect("apply");
}

/// A note with its vault file at `path`.
fn note(data: &Connection, id: &str, title: &str, path: &str, file_type: &str) {
    put(
        data,
        "note",
        id,
        serde_json::json!({ "title": title, "fileType": file_type, "emoji": ":n:" }),
    );
    data.execute(
        "INSERT INTO note_files (note_id, path, file_type, indexed_at) VALUES (?1, ?2, ?3, 0)",
        params![id, path, file_type],
    )
    .expect("note file");
}

fn journal(data: &Connection, id: &str, date: &str, title: &str) {
    put(
        data,
        "journal",
        id,
        serde_json::json!({ "date": date, "title": title }),
    );
    data.execute(
        "INSERT INTO note_files (note_id, path, indexed_at) VALUES (?1, ?2, 0)",
        params![id, format!("journal/{date}.md")],
    )
    .expect("journal file");
}

fn project(data: &Connection, id: &str, name: &str) {
    data.execute(
        "INSERT INTO projects (id, name, color) VALUES (?1, ?2, 'blue')",
        params![id, name],
    )
    .expect("project");
    data.execute(
        "INSERT INTO project_statuses (id, project_id, name, color, position)
         VALUES (?1, ?2, 'Doing', 'red', 0)",
        params![format!("{id}-doing"), id],
    )
    .expect("status");
}

fn task(data: &Connection, id: &str, title: &str, project: &str) {
    put(
        data,
        "task",
        id,
        serde_json::json!({
            "title": title, "projectId": project, "statusId": format!("{project}-doing"),
            "dueDate": "2026-01-10", "priority": 2,
        }),
    );
}

fn capture(data: &Connection, id: &str, payload: serde_json::Value) {
    put(data, "inbox", id, payload);
}

fn reindex(data: &Connection, index: &Connection) {
    search::reindex(data, index, NOW).expect("reindex");
}

fn query(text: &str) -> GroupedQuery {
    GroupedQuery {
        text: text.to_owned(),
        limit: 10,
        ..GroupedQuery::default()
    }
}

fn of(types: &[SearchType], text: &str) -> GroupedQuery {
    GroupedQuery {
        filter: SearchFilter {
            types: types.to_vec(),
            ..SearchFilter::default()
        },
        ..query(text)
    }
}

fn run(
    data: &Connection,
    index: &Connection,
    query: &GroupedQuery,
    hits: &[(&str, f64)],
) -> GroupedResponse {
    let hits: Vec<SemanticHit> = hits
        .iter()
        .map(|(id, cosine)| SemanticHit {
            id: (*id).to_owned(),
            cosine: *cosine,
        })
        .collect();
    search_all(data, index, query, &hits)
}

fn ids(response: &GroupedResponse, kind: SearchType) -> Vec<&str> {
    response
        .groups
        .iter()
        .find(|group| group.kind == kind)
        .map(|group| group.results.iter().map(|item| item.id.as_str()).collect())
        .unwrap_or_default()
}

fn kinds(response: &GroupedResponse) -> Vec<SearchType> {
    response.groups.iter().map(|group| group.kind).collect()
}

thread_local! {
    static STATEMENTS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn record(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(_, sql) = event {
        STATEMENTS.with(|statements| statements.borrow_mut().push(sql.to_owned()));
    }
}

/// The statements `read` runs on `index`, in order.
fn index_statements<T>(index: &Connection, read: impl FnOnce() -> T) -> (T, Vec<String>) {
    STATEMENTS.with(|statements| statements.borrow_mut().clear());
    index.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(record));
    let out = read();
    index.trace_v2(TraceEventCodes::empty(), None);
    (out, STATEMENTS.with(|statements| statements.take()))
}

/// How many times `statements` asked a full-text index for hits: one per
/// [`crate::domain::search::search`] pass over one type.
fn index_asks(statements: &[String]) -> usize {
    statements
        .iter()
        .filter(|sql| sql.contains("MATCH ?1"))
        .count()
}

/// `search.test.ts`: "maps exact FTS rows for notes, journals, tasks, and inbox items".
#[test]
fn every_type_answers_in_its_group_with_its_metadata() {
    let (data, index) = databases();
    note(&data, "n1", "Invoice plan", "projects/n1.md", "markdown");
    journal(&data, "j1", "2026-01-01", "Invoice day");
    project(&data, "project-a", "Alpha");
    task(&data, "t1", "Send invoice", "project-a");
    capture(
        &data,
        "i1",
        serde_json::json!({ "title": "Invoice link", "type": "link",
            "sourceUrl": "https://example.com", "sourceTitle": "Example" }),
    );
    reindex(&data, &index);

    let response = run(&data, &index, &query("invoice"), &[]);

    assert_eq!(response.total_count, 4);
    use SearchType::{Inbox, Journal, Note, Task};
    assert_eq!(kinds(&response), [Note, Journal, Task, Inbox]);
    let first = |at: usize| &response.groups[at].results[0];
    assert_eq!(first(0).id, "n1");
    assert_eq!(first(0).title, "Invoice plan");
    assert_eq!(first(0).match_type, MatchType::Exact);
    assert_eq!(first(0).normalized_score, 1.0, "a lone hit normalises to 1");
    assert!(first(0).score > 0.0, "the score is |bm25|");
    assert!(matches!(
        &first(0).meta,
        ItemMeta::Note { path: Some(path), emoji: Some(emoji), file_type, .. }
            if path == "projects/n1.md" && emoji == ":n:" && file_type == "markdown"
    ));
    assert!(matches!(
        &first(1).meta,
        ItemMeta::Journal { date, path: Some(path), .. }
            if date == "2026-01-01" && path == "journal/2026-01-01.md"
    ));
    assert!(matches!(
        &first(2).meta,
        ItemMeta::Task { project_id, project_name: Some(name), status_name: Some(status),
            due_date: Some(due), priority: 2, .. }
            if project_id == "project-a" && name == "Alpha" && status == "Doing" && due == "2026-01-10"
    ));
    assert!(matches!(
        &first(3).meta,
        ItemMeta::Inbox { item_type, source_url: Some(url), .. }
            if item_type == "link" && url == "https://example.com"
    ));
}

#[test]
fn no_searchable_term_answers_nothing() {
    let (data, index) = databases();
    note(&data, "n1", "Invoice", "n1.md", "markdown");
    reindex(&data, &index);
    assert_eq!(
        run(&data, &index, &query("  "), &[]),
        GroupedResponse::default()
    );
}

/// `search.test.ts`: "applies tags, date, folder, and project filters". Here the
/// folder and project filters apply on their own too.
#[test]
fn the_folder_and_project_filters_narrow_every_group() {
    let (data, index) = databases();
    note(
        &data,
        "in",
        "Budget plan",
        "projects/plans/in.md",
        "markdown",
    );
    note(&data, "out", "Budget other", "archive/out.md", "markdown");
    project(&data, "a", "Alpha");
    project(&data, "b", "Beta");
    task(&data, "ta", "Budget task", "a");
    task(&data, "tb", "Budget task too", "b");
    reindex(&data, &index);

    let folder = GroupedQuery {
        folder_path: Some("projects/plans".to_owned()),
        ..query("budget")
    };
    let response = run(&data, &index, &folder, &[]);
    assert_eq!(kinds(&response), [SearchType::Note], "tasks have no folder");
    assert_eq!(ids(&response, SearchType::Note), ["in"]);

    let project = GroupedQuery {
        project_id: Some("a".to_owned()),
        ..query("budget")
    };
    let response = run(&data, &index, &project, &[]);
    assert_eq!(kinds(&response), [SearchType::Task]);
    assert_eq!(ids(&response, SearchType::Task), ["ta"]);
}

/// `search.test.ts`: "filters note file types inside the FTS query so the cap counts
/// eligible rows": five filed images out-rank the one markdown note, and a limit of
/// one still returns the note.
#[test]
fn the_file_type_filter_counts_eligible_notes_only() {
    let (data, index) = databases();
    for at in 0..5 {
        note(
            &data,
            &format!("img{at}"),
            "Receipt",
            &format!("img{at}.png"),
            "image",
        );
    }
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
        ..of(&[SearchType::Note], "receipt")
    };
    assert_eq!(
        ids(&run(&data, &index, &markdown, &[]), SearchType::Note),
        ["md"]
    );

    let every = GroupedQuery {
        limit: 1,
        ..of(&[SearchType::Note], "receipt")
    };
    assert_eq!(
        ids(&run(&data, &index, &every, &[]), SearchType::Note),
        ["md"],
        "markdown notes lead filed files (search.ts:131)"
    );
}

#[test]
fn index_hits_normalise_and_a_typo_scores_as_fuzzy() {
    let (data, index) = databases();
    note(&data, "a", "zephyr zephyr zephyr", "a.md", "markdown");
    note(
        &data,
        "b",
        "zephyr and many other words in a long title",
        "b.md",
        "markdown",
    );
    reindex(&data, &index);

    let response = run(&data, &index, &of(&[SearchType::Note], "zephyr"), &[]);
    let scores: Vec<f64> = response.groups[0]
        .results
        .iter()
        .map(|item| item.normalized_score)
        .collect();
    assert_eq!(scores, [1.0, 0.0]);

    let typo = run(&data, &index, &of(&[SearchType::Note], "zephr"), &[]);
    let fuzzy = &typo.groups[0].results[0];
    assert_eq!(fuzzy.match_type, MatchType::Fuzzy);
    assert!(fuzzy.score > 0.0 && fuzzy.score <= 1.0);
    assert!((fuzzy.normalized_score - fuzzy.score * 0.8).abs() < 1e-12);
}

/// `search.test.ts`: "flattens quick search results and returns DB-backed stats".
#[test]
fn quick_search_flattens_by_normalised_score_and_stats_count_live_rows() {
    let (data, index) = databases();
    for at in 0..7 {
        note(
            &data,
            &format!("n{at}"),
            &format!("Quick {at}"),
            &format!("n{at}.md"),
            "markdown",
        );
    }
    project(&data, "p", "P");
    task(&data, "t", "Quick task", "p");
    capture(
        &data,
        "i",
        serde_json::json!({ "title": "Other", "type": "note" }),
    );
    reindex(&data, &index);

    let results = quick_search(&data, &index, "quick", &[], &[]);
    assert_eq!(results.len(), 6, "five notes and the task");
    assert!(
        results
            .windows(2)
            .all(|pair| pair[0].normalized_score >= pair[1].normalized_score)
    );

    let mut stats = stats(&data).expect("stats");
    assert_eq!(
        (stats.notes, stats.journals, stats.tasks, stats.inbox_items),
        (7, 0, 1, 1)
    );
    data.execute("UPDATE notes SET deleted_at = 1 WHERE id = 'n0'", [])
        .expect("tombstone");
    stats = super::stats(&data).expect("stats");
    assert_eq!(stats.notes, 6);
    assert_eq!(stats.total(), 8);
}
