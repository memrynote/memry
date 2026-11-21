//! The NotePlan importer over data folders written to a temp dir: calendar files to journal
//! entries and notes, the folder tree, task markers to task rows, `+` checklists kept plain,
//! links, tags, `_attachments` folders, file times, and hostile folders refused before
//! anything is written, each refusal in the summary.

use std::fs;
use std::path::{Path, PathBuf};

use memry_core::markdown::frontmatter::{YamlMap, YamlValue};
#[cfg(unix)]
use memry_desktop::import::noteplan::{ALREADY_WALKED, LINK_NOT_FOLLOWED, RESERVED_NAME};
use memry_desktop::import::noteplan::{
    MAX_FOLDER_DEPTH, NotePlanImporter, TOO_DEEP, convert_body, first_heading, lines_scanned,
    task_placeholder,
};
use memry_desktop::import::{ImportContext, ImportInput, ImportSummary, Importer, JournalEntry};
use memry_test_kit::{assert_steps_at_most, on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::import_support::{RecordingSink, Timeline};

fn write(root: &Path, rel: &str, text: &str) -> PathBuf {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    path
}

fn run_sink(
    source: &Path,
    configure: impl FnOnce(&mut RecordingSink),
) -> (Vec<Value>, ImportSummary) {
    let timeline = Timeline::default();
    let mut sink = RecordingSink::new(timeline.clone());
    configure(&mut sink);
    let mut ctx = ImportContext::new("noteplan", CancellationToken::new(), Box::new(|_| {}));
    let input = ImportInput {
        source_paths: vec![source.to_string_lossy().into_owned()],
        options: None,
    };
    NotePlanImporter.run(&input, &mut ctx, &sink).unwrap();
    let writes = timeline.lock().unwrap().clone();
    (writes, ctx.summary())
}

fn run(source: &Path) -> (Vec<Value>, ImportSummary) {
    run_sink(source, |_| {})
}

fn ops<'a>(writes: &'a [Value], op: &str) -> Vec<&'a Value> {
    writes.iter().filter(|w| w["op"] == op).collect()
}

fn note<'a>(writes: &'a [Value], title: &str) -> &'a Value {
    ops(writes, "createNoteAsWritten")
        .into_iter()
        .find(|n| n["title"] == title)
        .unwrap_or_else(|| panic!("no note titled {title}"))
}

fn reasons(summary: &ImportSummary) -> Vec<(String, usize)> {
    serde_json::to_value(summary).unwrap()["skippedReasons"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| {
            (
                g["reason"].as_str().unwrap().to_owned(),
                g["count"].as_u64().unwrap() as usize,
            )
        })
        .collect()
}

fn skipped_for(summary: &ImportSummary, reason: &str) -> usize {
    reasons(summary)
        .into_iter()
        .find(|(r, _)| r == reason)
        .map_or(0, |(_, n)| n)
}

#[test]
fn calendar_days_become_journal_entries_and_the_rest_notes_in_the_tree() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Calendar/20260812.txt", "# Monday\nday text\n");
    write(dir.path(), "Calendar/2026-W33.txt", "week text\n");
    write(dir.path(), "Calendar/2026-02-31.txt", "no such day\n");
    write(
        dir.path(),
        "Notes/10 - Projects/aurora.txt",
        "# Aurora\nbody\n",
    );
    write(dir.path(), "Notes/Filters/hidden.txt", "ignored\n");
    write(dir.path(), "@Archive/old.md", "# Old\n");
    write(dir.path(), "Filters/All Tasks.txt", "ignored\n");

    let (writes, summary) = run(dir.path());

    let journals = ops(&writes, "createJournalEntry");
    assert_eq!(journals.len(), 1);
    assert_eq!(journals[0]["date"], "2026-08-12");
    // A journal entry has no title field, so the H1 stays in its body.
    assert_eq!(journals[0]["content"], "# Monday\nday text\n");
    assert_eq!(note(&writes, "2026-W33")["folder"], "NotePlan/Calendar");
    assert_eq!(note(&writes, "Aurora")["folder"], "NotePlan/10 - Projects");
    assert_eq!(note(&writes, "Aurora")["content"], "body\n");
    assert_eq!(note(&writes, "Old")["folder"], "NotePlan/Archive");
    assert_eq!(ops(&writes, "createNoteAsWritten").len(), 3);
    assert_eq!(
        ops(&writes, "createNote").len(),
        0,
        "never through the checklist step"
    );
    assert_eq!(skipped_for(&summary, "Not a NotePlan calendar filename"), 1);
    assert_eq!(summary.imported, 4);
}

#[test]
fn task_markers_become_task_rows_and_checklists_stay_plain() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Notes/tasks.txt",
        "# Tasks\n* Open >2026-08-13\n* [x] Done @done(2026-08-12)\n* [-] Cancelled\n\t* Child\n+ [x] Gym\n+ Emails\n- bullet\n",
    );

    let (writes, _) = run(dir.path());

    let tasks = ops(&writes, "createTask");
    let titles: Vec<_> = tasks.iter().map(|t| t["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["Open", "Done", "Cancelled", "Child"]);
    assert_eq!(tasks[0]["dueDate"], "2026-08-13");
    assert_eq!(tasks[0]["projectId"], "inbox");
    assert_eq!(tasks[3]["parentId"], "task-3");
    let created = note(&writes, "Tasks");
    assert!(tasks.iter().all(|t| t["sourceNoteId"] == created["id"]));
    assert_eq!(ops(&writes, "completeTask")[0]["completedAt"], "2026-08-12");
    assert_eq!(ops(&writes, "archiveTask")[0]["id"], "task-3");
    assert_eq!(
        created["content"],
        "- [ ] Open {task:task-1}\n- [x] Done {task:task-2}\n- [x] Cancelled {task:task-3}\n  - [ ] Child {task:task-4}\n- [x] Gym\n- [ ] Emails\n- bullet\n"
    );
}

#[test]
fn without_an_inbox_tasks_stay_checkboxes_and_the_summary_says_so() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "a.txt", "# A\n* Task\n* [x] Done\n");

    let (writes, summary) = run_sink(dir.path(), |sink| sink.inbox = None);

    assert!(ops(&writes, "createTask").is_empty());
    assert_eq!(note(&writes, "A")["content"], "- [ ] Task\n- [x] Done\n");
    assert_eq!(
        skipped_for(&summary, "No Inbox project to import tasks into"),
        1
    );
}

#[test]
fn an_existing_journal_entry_is_appended_to_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Calendar/20260101.txt",
        "---\nmood: tired\n---\nimported #tag\n",
    );
    let mut properties = YamlMap::new();
    properties.insert("mood".to_owned(), YamlValue::String("calm".to_owned()));
    properties.insert("weather".to_owned(), YamlValue::String("sun".to_owned()));

    let (writes, _) = run_sink(dir.path(), |sink| {
        sink.journals.insert(
            "2026-01-01".to_owned(),
            JournalEntry {
                content: "\nmine\n".to_owned(),
                tags: vec!["mine".to_owned()],
                properties,
            },
        );
    });

    let entry = ops(&writes, "createJournalEntry")[0];
    assert_eq!(
        entry["content"],
        "mine\n\n## Imported from NotePlan\n\nimported #tag\n"
    );
    assert_eq!(entry["tags"], serde_json::json!(["mine", "tag"]));
    assert_eq!(
        entry["properties"],
        serde_json::json!([["mood", "tired"], ["weather", "sun"]])
    );
}

#[test]
fn links_tags_attachments_and_file_times_carry_over() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Notes/My Note.txt",
        "---\ntags: [area]\nicon: rocket\ntype: guide\n---\n# My Note\nSee [[Other]] #books/decisive no#42\n![shot](My%20Note_attachments/shot.png)\n```\n#fenced\n```\n",
    );
    write(dir.path(), "Notes/My Note_attachments/shot.png", "png");
    let modified =
        std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    fs::File::options()
        .write(true)
        .open(dir.path().join("Notes/My Note.txt"))
        .unwrap()
        .set_modified(modified)
        .unwrap();

    let (writes, summary) = run(dir.path());

    let created = note(&writes, "My Note");
    assert_eq!(
        created["tags"],
        serde_json::json!(["area", "books/decisive"])
    );
    assert_eq!(
        created["properties"],
        serde_json::json!([["type", "guide"]])
    );
    assert_eq!(created["modified"], "2023-11-14T22:13:20.000Z");
    assert_eq!(created["created"], "<birthtime>");
    let content = created["content"].as_str().unwrap();
    assert!(content.contains("[[Other]]"));
    assert!(content.contains(&format!(
        "attachments/{}/shot.png",
        created["id"].as_str().unwrap()
    )));
    assert_eq!(ops(&writes, "saveAttachment").len(), 1);
    assert_eq!(summary.attachments, 1);
}

#[cfg(unix)]
#[test]
fn links_are_never_followed_and_each_is_reported() {
    use std::os::unix::fs::symlink;
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "secret.txt", "# Secret\n* leak\n");
    write(outside.path(), "dir/inner.txt", "# Inner\n");
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Notes/kept.txt", "# Kept\n");
    symlink(
        outside.path().join("secret.txt"),
        dir.path().join("Notes/secret.txt"),
    )
    .unwrap();
    symlink(outside.path().join("dir"), dir.path().join("Notes/dir")).unwrap();

    let (writes, summary) = run(dir.path());

    let titles: Vec<_> = ops(&writes, "createNoteAsWritten")
        .iter()
        .map(|n| n["title"].clone())
        .collect();
    assert_eq!(titles, ["Kept"]);
    assert!(ops(&writes, "createTask").is_empty());
    assert_eq!(skipped_for(&summary, LINK_NOT_FOLLOWED), 2);
}

fn titles(writes: &[Value]) -> Vec<Value> {
    ops(writes, "createNoteAsWritten")
        .iter()
        .map(|n| n["title"].clone())
        .collect()
}

/// A synced install's data folder is often a link: Electron followed an area link wherever it
/// pointed, and so does this.
#[cfg(unix)]
#[test]
fn an_area_folder_linked_outside_the_pick_is_imported() {
    let outside = tempfile::tempdir().unwrap();
    write(
        outside.path(),
        "sub/n.txt",
        "# Elsewhere
",
    );
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Calendar/2026.txt",
        "# Year
",
    );
    std::os::unix::fs::symlink(outside.path(), dir.path().join("Notes")).unwrap();

    let (writes, summary) = run(dir.path());

    assert_eq!(titles(&writes), ["Year", "Elsewhere"]);
    assert_eq!(note(&writes, "Elsewhere")["folder"], "NotePlan/sub");
    assert_eq!(summary.skipped, 0);
    assert!(summary.failed.is_empty());
}

#[cfg(unix)]
#[test]
fn an_area_link_inside_the_pick_is_walked() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "store/notes/a.txt", "# A\n");
    std::os::unix::fs::symlink(dir.path().join("store/notes"), dir.path().join("Notes")).unwrap();

    let (writes, summary) = run(dir.path());

    assert_eq!(titles(&writes), ["A"]);
    assert_eq!(note(&writes, "A")["folder"], "NotePlan");
    assert_eq!(summary.skipped, 0);
}

/// `Notes` pointing back at the pick would walk `Calendar` a second time as notes, and two
/// links pointing at each other never resolve: each folder is walked once and the loop is
/// reported.
#[cfg(unix)]
#[test]
fn an_area_link_cycle_terminates() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Calendar/20260812.txt", "day\n");
    write(dir.path(), "loose.txt", "# Loose\n");
    symlink(dir.path(), dir.path().join("Notes")).unwrap();
    symlink(dir.path().join("loop"), dir.path().join("@Archive")).unwrap();
    symlink(dir.path().join("@Archive"), dir.path().join("loop")).unwrap();

    let (writes, summary) = run(dir.path());

    assert_eq!(ops(&writes, "createJournalEntry").len(), 1);
    assert_eq!(titles(&writes), ["Loose"]);
    assert_eq!(skipped_for(&summary, ALREADY_WALKED), 1);
    let failed: Vec<_> = summary.failed.iter().map(|f| f.item.as_str()).collect();
    assert_eq!(failed, ["@Archive"]);
}

#[cfg(unix)]
#[test]
fn an_area_link_to_a_missing_target_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Calendar/2026.txt", "# Year\n");
    std::os::unix::fs::symlink(dir.path().join("gone"), dir.path().join("Notes")).unwrap();

    let (writes, summary) = run(dir.path());

    assert_eq!(titles(&writes), ["Year"]);
    let failed: Vec<_> = summary.failed.iter().map(|f| f.item.as_str()).collect();
    assert_eq!(failed, ["Notes"]);
}

/// `resolveJournalEntryId` threw into the entry's catch: that entry fails, the rest import.
#[test]
fn a_journal_id_the_sink_cannot_resolve_fails_that_entry() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Calendar/20260812.txt", "* task\n");
    write(dir.path(), "Notes/a.txt", "# A\n");

    let (writes, summary) = run_sink(dir.path(), |sink| sink.fail_journal_id = true);

    assert!(ops(&writes, "createJournalEntry").is_empty());
    assert!(ops(&writes, "createTask").is_empty());
    assert_eq!(titles(&writes), ["A"]);
    assert_eq!(summary.failed.len(), 1);
    assert_eq!(summary.failed[0].error, "no journal id");
}

/// Departure 8: Electron's `.` stopped at a CR or U+2028 and dropped the rest of the line.
#[test]
fn text_after_a_mid_line_cr_or_line_separator_is_kept() {
    let converted = convert_body("* call\rBob\n* pay\u{2028}rent\n", true);
    let titles: Vec<_> = converted.tasks.iter().map(|t| t.title.as_str()).collect();
    assert_eq!(titles, ["call\rBob", "pay\u{2028}rent"]);
    assert_eq!(
        first_heading("# Plan\u{2028}B\n").as_deref(),
        Some("Plan\u{2028}B")
    );
}

#[test]
fn a_wiki_link_in_a_task_title_is_left_as_written() {
    let converted = convert_body("* call [[Bob Smith]] >2026-01-02\n", true);
    assert_eq!(converted.tasks[0].title, "call [[Bob Smith]]");
}

#[test]
fn an_asset_ref_climbing_out_of_the_pick_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let pick = dir.path().join("pick");
    write(dir.path(), "secret.png", "png");
    write(
        &pick,
        "Notes/a.txt",
        "# A\n![x](../../secret.png)\n![y](/etc/hosts)\n",
    );

    let (writes, summary) = run(&pick);

    assert!(ops(&writes, "saveAttachment").is_empty());
    assert_eq!(
        skipped_for(&summary, "Path traversal outside selected folder"),
        1
    );
    assert_eq!(
        note(&writes, "A")["content"],
        "![x](../../secret.png)\n![y](/etc/hosts)\n"
    );
}

#[test]
fn a_file_over_the_size_cap_fails_before_anything_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let huge = write(dir.path(), "Notes/huge.txt", "");
    // Sparse: the size check runs before the read.
    fs::File::options()
        .write(true)
        .open(&huge)
        .unwrap()
        .set_len(memry_desktop::import::MAX_SOURCE_BYTES + 1)
        .unwrap();
    write(dir.path(), "Notes/small.txt", "# Small\n");

    let (writes, summary) = run(dir.path());

    assert_eq!(ops(&writes, "createNoteAsWritten").len(), 1);
    assert_eq!(summary.failed.len(), 1);
    assert!(summary.failed[0].item.ends_with("huge.txt"));
    assert_eq!(summary.failed[0].error, "File is larger than 100 MB");
}

#[test]
fn folders_past_the_depth_cap_are_refused_and_reported() {
    let dir = tempfile::tempdir().unwrap();
    let mut rel = String::from("Notes");
    for level in 0..MAX_FOLDER_DEPTH + 3 {
        rel.push_str(&format!("/{level}"));
        write(
            dir.path(),
            &format!("{rel}/n{level}.txt"),
            &format!("# N{level}\n"),
        );
    }

    let (writes, summary) = on_small_stack({
        let path = dir.path().to_path_buf();
        move || run(&path)
    });

    assert_eq!(ops(&writes, "createNoteAsWritten").len(), MAX_FOLDER_DEPTH);
    assert_eq!(skipped_for(&summary, TOO_DEEP), 1);
}

// Windows cannot create a folder named CON or lpt1.old through Win32 paths (os error 267), so the
// fixture exists only on unix filesystems, where such a folder can arrive from a synced copy.
#[cfg(unix)]
#[test]
fn a_folder_with_a_windows_device_name_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Notes/CON/a.txt", "# In con\n");
    write(dir.path(), "Notes/lpt1.old/b.txt", "# In lpt\n");
    write(dir.path(), "Notes/console/c.txt", "# Fine\n");

    let (writes, summary) = run(dir.path());

    let titles: Vec<_> = ops(&writes, "createNoteAsWritten")
        .iter()
        .map(|n| n["title"].clone())
        .collect();
    assert_eq!(titles, ["Fine"]);
    assert_eq!(skipped_for(&summary, RESERVED_NAME), 2);
}

#[test]
fn deep_task_indentation_converts_on_a_small_stack() {
    let mut body = String::new();
    for depth in 0..4_000 {
        body.push_str(&"\t".repeat(depth % 2_000));
        body.push_str("* t\n");
    }
    let converted = on_small_stack(move || convert_body(&body, true));
    assert_eq!(converted.tasks.len(), 4_000);
    assert_eq!(converted.tasks[1].parent_temp_id.as_deref(), Some("t0"));
}

#[test]
fn conversion_reads_each_line_once() {
    let body = "* [x] task @done(2026-01-01) >2026-01-02\n+ list\n```\n* fenced\n```\n# H\n#tag\n"
        .repeat(5_000);
    let lines = body.split('\n').count();
    assert_steps_at_most("lines scanned per conversion", lines_scanned, lines, || {
        convert_body(&body, true);
    });
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn conversion_keeps_every_line_and_stays_bounded(
        text in "([*+-]( |\\t)|\\t|    |\\[[ xX>-]\\] |@done\\(2026-01-0[1-9]\\)|>2026-02-0[1-9]|```|#|\\r|\\u{2028}|[a é])*(\\n([*+-]( |\\t)|\\t|\\[[ xX>-]\\] |[a ])*){0,20}",
        nested in any::<bool>(),
    ) {
        let converted = convert_body(&text, nested);
        prop_assert_eq!(converted.markdown.split('\n').count(), text.split('\n').count());
        let placeholders = converted.tasks.iter()
            .filter(|t| converted.markdown.contains(&task_placeholder(&t.temp_id)))
            .count();
        prop_assert_eq!(placeholders, converted.tasks.len());
        prop_assert!(converted.markdown.len() <= output_bound(text.len()));
    }
}
