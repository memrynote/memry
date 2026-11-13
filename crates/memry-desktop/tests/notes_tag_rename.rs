//! A tag renamed across the vault (`tags:rename`, #3530 13j-4) under the running vault tier with
//! `NotesIdentity` and the note index: each note's file and record take the new name once (one
//! outbox row each), a day's record and body do and its header does not, a rename the app did
//! not finish is finished by the next open, and an outside edit that lands during the rename
//! is kept.

#[allow(unused_imports)]
use crate::vault_env;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::index_support::until;
use memry_core::api::search::Search;
use memry_core::api::tag_hub::TagHub;
use memry_core::domain::tag_rename::{Recorded, RenameJob, RenamePlan};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::journal::write::NewDay;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::{HeaderTagEditInput, NoteUpdateInput};
use memry_desktop::vault::activity::ActivityFilter;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use vault_env::{Env, QUIET, env, indexed};

/// An open vault, its first walk done, with the note index and the notes service, which
/// resumes a recorded rename at every open.
pub(crate) fn opened() -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {}).register(&e.session);
    let store = store.into_inner().unwrap().unwrap();
    let notes = NotesService::new(e.tier.clone(), store.clone());
    notes.register_resume(&e.session);
    e.open();
    e.facts_until(indexed);
    (e, notes, store)
}

pub(crate) fn hub(e: &Env, store: &Arc<dyn SecureStore>) -> TagHub {
    e.core().tag_hub(store.clone()).unwrap()
}

/// The recorded rename's plan, read as the app reads it.
fn plan(e: &Env) -> Option<RenamePlan> {
    match e.core().tag_rename_recorded().unwrap() {
        None => None,
        Some(Recorded::Plan(plan)) => Some(plan),
        Some(Recorded::Unreadable(what)) => panic!("{what}"),
    }
}

fn job(from: &str, to: &str) -> RenameJob {
    RenameJob {
        from: from.into(),
        to: to.into(),
        run_id: "run".into(),
    }
}

pub(crate) fn note(
    notes: &NotesService,
    e: &Env,
    title: &str,
    content: &str,
    tags: &[&str],
) -> String {
    let open = e.session.current().unwrap();
    let note = NewNoteFile {
        title: title.into(),
        content: content.into(),
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        ..NewNoteFile::default()
    };
    notes.create(&open, note).unwrap().id
}

/// A list of the record's payload, `tags` or `pinnedTags`.
pub(crate) fn record(e: &Env, id: &str, key: &str) -> Vec<String> {
    let (id, path) = (id.to_owned(), format!("$.{key}"));
    let list: Option<String> = e
        .core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT json_extract(payload, ?2) FROM sync_items WHERE item_id = ?1 \
                     AND item_type IN ('note', 'journal')",
                    [id, path],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap();
    list.map_or_else(Vec::new, |list| serde_json::from_str(&list).unwrap())
}

/// The record pushes queued for `id`, after the last [`clear_outbox`].
pub(crate) fn upserts(e: &Env, id: &str) -> i64 {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE op = 'upsert' AND item_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap()
}

pub(crate) fn clear_outbox(e: &Env) {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            conn.execute("DELETE FROM outbox", []).unwrap();
            Ok(())
        })
        .unwrap();
}

pub(crate) fn path_of(e: &Env, id: &str) -> String {
    e.core()
        .note_files()
        .by_id(id)
        .unwrap()
        .expect("a row")
        .path
}

/// Waits until the index measured the bytes the note's row names.
pub(crate) fn measured(e: &Env, id: &str) {
    let search = e.session.current().expect("open").search;
    until("the file measured", || {
        let row = e.core().note_files().by_id(id).unwrap().expect("a row");
        let stats = search.note_stats(id).unwrap();
        row.content_hash.is_some() && stats.and_then(|s| s.file_hash) == row.content_hash
    });
}

#[test]
fn a_rename_writes_each_file_and_record_once_and_merges_into_a_name_in_use() {
    let (mut e, notes, store) = opened();
    let plan = note(
        &notes,
        &e,
        "Plan",
        "Met #job and #job/lead, not #jobs. `#job`",
        &["job", "ideas"],
    );
    let merge = note(&notes, &e, "Merge", "Plain text", &["Career", "job"]);
    let hub = hub(&e, &store);
    assert!(hub.set_pinned(&merge, "job", true).unwrap());
    hub.set_color("job", "#ff0000").unwrap();
    let open = e.session.current().unwrap();
    let day = NewDay {
        date: "2025-04-01".into(),
        content: "Walked #job".into(),
        tags: vec!["job".into()],
        ..NewDay::default()
    };
    let day = notes.create_day(&open, day).unwrap().id;
    // A file found outside: only its header carries the tag (its record takes none, #3825).
    e.write("Found.md", "---\ntags: [job]\n---\nfound\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "Found.md"));
    let found = e
        .rows()
        .into_iter()
        .find(|(_, p)| p == "Found.md")
        .unwrap()
        .0;
    for id in [&plan, &merge, &day, &found] {
        measured(&e, id);
    }
    // The index defines `Career` as Electron's does (#4418): the merge keeps its colour.
    let search = e.session.current().unwrap().search;
    let career = |search: &Search| search.tag_colors(vec!["career".into()]).unwrap().remove(0);
    until("career defined", || career(&search).is_some());
    let career_color = career(&search);
    let before: Vec<String> = [&plan, &merge, &day]
        .iter()
        .map(|id| e.read(&path_of(&e, id)))
        .collect();
    std::thread::sleep(QUIET);
    e.drain();
    clear_outbox(&e);
    let activity = |e: &Env| {
        e.tier
            .activity()
            .list(1000, ActivityFilter::All)
            .entries
            .len()
    };
    let logged = activity(&e);

    let mut told = Vec::new();
    let renamed = notes
        .rename_tag(&open, &job("job", "career"), &mut |done, total| {
            told.push((done, total))
        })
        .unwrap();
    assert_eq!(renamed.failed_note_ids, Vec::<String>::new());
    assert_eq!(renamed.written.len(), 4);
    assert!(!renamed.body_skipped);
    assert_eq!(told.last(), Some(&(4, 4)));

    let plan_text = before[0]
        .replace("  - job\n", "  - career\n")
        .replace("#job and #job/lead", "#career and #career/lead");
    assert_eq!(
        e.read("Plan.md"),
        plan_text,
        "only the tags and the body's #tags"
    );
    assert!(plan_text.contains("not #jobs. `#job`"), "{plan_text}");
    assert_eq!(record(&e, &plan, "tags"), ["career", "ideas"]);
    // The merge collapses into the spelling the note had, and the pin follows in it.
    assert_eq!(record(&e, &merge, "tags"), ["Career"]);
    assert_eq!(record(&e, &merge, "pinnedTags"), ["Career"]);
    assert!(
        !e.read("Merge.md").contains("job"),
        "{}",
        e.read("Merge.md")
    );
    // A day's header is the author's: its record and its body take the name, its header not.
    let day_text = e.read(&path_of(&e, &day));
    assert_eq!(day_text, before[2].replace("Walked #job", "Walked #career"));
    assert_eq!(record(&e, &day, "tags"), ["career"]);
    assert_eq!(e.read("Found.md"), "---\ntags:\n  - career\n---\nfound\n");
    for id in [&plan, &merge, &day] {
        assert_eq!(upserts(&e, id), 1, "{id}");
    }
    assert_eq!(
        upserts(&e, &found),
        0,
        "the found note's record carries no tag"
    );
    // A merge: the name in use keeps its own definition (desktop `renameTagDefinition`).
    let colors = search.tag_colors(vec!["career".into(), "job".into()]);
    assert_eq!(colors.unwrap(), [career_color, None]);

    // The watcher reports none of the writes as outside edits.
    std::thread::sleep(QUIET);
    let facts = e.drain();
    let watcher = |f: &&Applied| {
        matches!(
            f,
            Applied::Changed {
                source: ChangeSource::Watcher,
                ..
            }
        )
    };
    assert_eq!(facts.iter().filter(watcher).count(), 0, "{facts:?}");
    assert_eq!(
        activity(&e),
        logged,
        "the activity log took a write for an outside edit"
    );

    // A second run finds nothing to do.
    clear_outbox(&e);
    let again = notes.rename_tag(&open, &job("job", "career"), &mut |_, _| {});
    assert_eq!(again.unwrap().written.len(), 0);
    assert_eq!(e.read("Plan.md"), plan_text);
    assert_eq!(
        upserts(&e, &plan) + upserts(&e, &merge) + upserts(&e, &day),
        0
    );
}

/// #3847: a case-only rename respells the files and records and leaves the definition under
/// its id, so no second spelling's definition is made; a name that cannot be an inline tag
/// leaves the bodies.
#[test]
fn a_case_only_rename_keeps_the_definition_and_a_spaced_name_leaves_the_bodies() {
    let (e, notes, store) = opened();
    let id = note(&notes, &e, "Work", "Deep #Work today", &["Work"]);
    hub(&e, &store).set_color("Work", "teal").unwrap();
    let open = e.session.current().unwrap();

    let renamed = notes.rename_tag(&open, &job("Work", "work"), &mut |_, _| {});
    assert_eq!(renamed.unwrap().written.len(), 1);
    let text = e.read("Work.md");
    assert!(
        text.contains("  - work\n") && text.contains("Deep #work today"),
        "{text}"
    );
    assert_eq!(record(&e, &id, "tags"), ["work"]);
    let definitions: Vec<String> = e
        .core()
        .db_handle()
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT item_id FROM sync_items WHERE item_type = 'tag_definition' \
                     AND deleted_at IS NULL",
                )
                .unwrap();
            Ok(statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap())
        })
        .unwrap();
    assert_eq!(definitions, ["Work"]);
    let colors = open.search.tag_colors(vec!["work".into()]).unwrap();
    assert_eq!(colors, [Some("teal".to_owned())]);

    let spaced = notes
        .rename_tag(&open, &job("work", "deep work"), &mut |_, _| {})
        .unwrap();
    assert!(spaced.body_skipped);
    let text = e.read("Work.md");
    assert!(
        text.contains("  - deep work\n") && text.contains("Deep #work today"),
        "{text}"
    );
    assert_eq!(record(&e, &id, "tags"), ["deep work"]);
}

/// A rename ended after its first note: the next open finishes the other, and writes the first
/// file no second time.
#[test]
fn a_rename_the_app_did_not_finish_is_finished_by_the_next_open() {
    let (mut e, notes, _) = opened();
    let ids = [
        note(&notes, &e, "One", "#job one", &["job"]),
        note(&notes, &e, "Two", "#job two", &["job"]),
    ];
    let open = e.session.current().unwrap();
    let done = Arc::new(AtomicUsize::new(0));
    let seen = done.clone();
    let stopped = notes.rename_tag_until(
        &open,
        &job("job", "career"),
        &mut |at, _| seen.store(at, Ordering::SeqCst),
        &|| done.load(Ordering::SeqCst) >= 1,
    );
    assert!(matches!(stopped, Err(NotesError::Closed)), "{stopped:?}");
    let texts: Vec<String> = ids.iter().map(|id| e.read(&path_of(&e, id))).collect();
    let first = texts
        .iter()
        .position(|t| t.contains("#career"))
        .expect("one renamed");
    assert!(texts[1 - first].contains("#job"), "{texts:?}");
    assert_eq!(record(&e, &ids[first], "tags"), ["career"]);
    assert!(plan(&e).is_some());
    drop(open);
    std::thread::sleep(QUIET);
    e.close();
    e.drain();

    e.open();
    until("the rename finished", || plan(&e).is_none());
    for id in &ids {
        let text = e.read(&path_of(&e, id));
        assert!(
            text.contains("  - career\n") && !text.contains("job"),
            "{text}"
        );
        assert_eq!(record(&e, id, "tags"), ["career"]);
    }
    assert_eq!(
        e.read(&path_of(&e, &ids[first])),
        texts[first],
        "written once"
    );
}

/// A crash after a note's file took the rename and before its record did: the next open finds
/// the file's text the rename wrote and renames the record alone, so the file takes the rename
/// once even when the new name sits under the old one (`a` to `a/b` never makes `a/b/b`).
#[test]
fn a_crash_between_a_file_and_its_record_never_renames_the_file_twice() {
    let (mut e, notes, _) = opened();
    let ids = [
        note(&notes, &e, "One", "#a one", &["a"]),
        note(&notes, &e, "Two", "#a two", &["a"]),
    ];
    let open = e.session.current().unwrap();
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    let texts: Vec<String> = ids.iter().map(|id| e.read(&path_of(&e, id))).collect();
    let first = texts
        .iter()
        .position(|t| t.contains("#a/b"))
        .expect("one file written");
    assert!(!texts[1 - first].contains("a/b"), "{texts:?}");
    assert_eq!(record(&e, &ids[first], "tags"), ["a"], "its record not yet");
    drop(open);
    std::thread::sleep(QUIET);
    e.close();
    e.drain();

    e.open();
    until("the rename finished", || plan(&e).is_none());
    for id in &ids {
        let text = e.read(&path_of(&e, id));
        assert!(
            text.contains("  - a/b\n") && text.contains("#a/b ") && !text.contains("a/b/b"),
            "{text}"
        );
        assert_eq!(record(&e, id, "tags"), ["a/b"]);
    }
    assert_eq!(
        e.read(&path_of(&e, &ids[first])),
        texts[first],
        "written once"
    );
}

/// A note the rename could not write stays in its plan and keeps the rename recorded, refusing
/// another as unfinished with the notes it has left; asking the same rename again tries that note alone, so `a` to `a/b` renames the others no
/// second time.
#[test]
fn a_note_the_rename_could_not_write_is_tried_again_by_the_same_rename_alone() {
    let (e, notes, _) = opened();
    let ids = [
        note(&notes, &e, "One", "#a one", &["a"]),
        note(&notes, &e, "Two", "#a two", &["a"]),
    ];
    let open = e.session.current().unwrap();
    notes.fail_next_rename_edit();
    let first = notes
        .rename_tag(&open, &job("a", "a/b"), &mut |_, _| {})
        .unwrap();
    assert_eq!(first.written.len(), 1);
    let [failed] = &first.failed_note_ids[..] else {
        panic!("{first:?}")
    };
    assert!(e.read(&path_of(&e, failed)).contains("#a "));
    assert_eq!(record(&e, failed, "tags"), ["a"]);
    let recorded = plan(&e).expect("still recorded");
    let left: Vec<&str> = recorded.holders.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(left, [failed.as_str()]);
    let other = notes.rename_tag(&open, &job("x", "y"), &mut |_, _| {});
    assert!(
        matches!(
            &other,
            Err(NotesError::TagRenameUnfinished { from, to, left: 1 }) if from == "a" && to == "a/b"
        ),
        "{other:?}"
    );

    let again = notes
        .rename_tag(&open, &job("a", "a/b"), &mut |_, _| {})
        .unwrap();
    assert_eq!(
        (again.written.len(), again.failed_note_ids),
        (1, Vec::new())
    );
    assert!(plan(&e).is_none());
    for id in &ids {
        let text = e.read(&path_of(&e, id));
        assert!(
            text.contains("  - a/b\n") && text.contains("#a/b ") && !text.contains("a/b/b"),
            "{text}"
        );
        assert_eq!(record(&e, id, "tags"), ["a/b"]);
    }
}

/// A crash after a note's file took the rename, then an edit outside of that file before the
/// next open: whether the file holds the rename cannot be told, so it is left as edited, its
/// record takes the new name, and it is answered as a note the rename could not write.
#[test]
fn a_file_edited_outside_after_a_crash_is_left_and_answered() {
    let (mut e, notes, _) = opened();
    let id = note(&notes, &e, "One", "#a one", &["a"]);
    let path = path_of(&e, &id);
    let open = e.session.current().unwrap();
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    drop(open);
    std::thread::sleep(QUIET);
    e.close();
    e.drain();
    let edited = e.read(&path).replace("#a/b one", "#a/b one, edited");
    std::fs::write(e.vault.join(&path), &edited).unwrap();

    e.open();
    until("the rename finished", || plan(&e).is_none());
    assert_eq!(e.read(&path), edited);
    assert_eq!(record(&e, &id, "tags"), ["a/b"]);
}

/// A day's header keeps the old name and the rename does not move the day's baseline: a later
/// outside edit that adds a tag to the header adds it to the record, and the old name the header
/// still holds does not come back (#3931).
#[test]
fn an_outside_edit_of_a_renamed_days_header_adds_its_new_tag_alone() {
    let (mut e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let day = NewDay {
        date: "2025-04-02".into(),
        content: "Walked".into(),
        tags: vec!["job".into()],
        ..NewDay::default()
    };
    let day = notes.create_day(&open, day).unwrap().id;
    measured(&e, &day);
    let renamed = notes.rename_tag(&open, &job("job", "career"), &mut |_, _| {});
    assert_eq!(renamed.unwrap().failed_note_ids, Vec::<String>::new());
    assert_eq!(record(&e, &day, "tags"), ["career"]);
    let path = path_of(&e, &day);
    let text = e.read(&path);
    assert!(text.contains("  - job\n"), "{text}");

    e.write(&path, &text.replace("  - job\n", "  - job\n  - x\n"));
    until("the record took the added tag", || {
        record(&e, &day, "tags") == ["career", "x"]
    });
    std::thread::sleep(QUIET);
    e.drain();
    assert_eq!(record(&e, &day, "tags"), ["career", "x"]);
}

/// An edit outside the app that lands while the rename writes a file meets the rename's body,
/// which the note took first, and loses to it as to unwritten typing (#4030): it is kept as a
/// version, and its frontmatter stays the file's, so the record takes the file's tags, not the
/// rename's.
#[test]
fn an_outside_edit_during_the_rename_is_kept() {
    let (mut e, notes, _) = opened();
    let id = note(&notes, &e, "Plan", "#job here", &["job"]);
    measured(&e, &id);
    let outside = "---\ntags: [other]\n---\nFrom another editor\n";
    let file = e.vault.join("Plan.md");
    notes.before_next_rename_lands(Box::new(move || std::fs::write(file, outside).unwrap()));
    let open = e.session.current().unwrap();
    let renamed = notes.rename_tag(&open, &job("job", "career"), &mut |_, _| {});
    assert_eq!(renamed.unwrap().written.len(), 0);
    e.facts_until(|f| matches!(f, Applied::OutsideEditKept { note_id, .. } if *note_id == id));
    until(
        "the rename's body written under the outside frontmatter",
        || e.read("Plan.md") == "---\ntags: [other]\n---\n#career here\n",
    );
    assert!(e.versions(&id).iter().any(|v| v == outside));
    until("the record took the file's tags", || {
        record(&e, &id, "tags") == ["other"]
    });
}

/// The same rename asked while it runs (a resume at open beside the user's, a second submit) is
/// refused as running: beside it, it would rename again what the first renamed, and `a` to
/// `a/b` would make `a/b/b`.
#[test]
fn a_rename_asked_while_it_runs_is_refused_and_renames_nothing_twice() {
    let (e, notes, _) = opened();
    let ids = [
        note(&notes, &e, "One", "#a one", &["a"]),
        note(&notes, &e, "Two", "#a two", &["a"]),
        note(&notes, &e, "Three", "#a three", &["a"]),
    ];
    let open = e.session.current().unwrap();
    let mut inner = None;
    let renamed = notes
        .rename_tag(&open, &job("a", "a/b"), &mut |done, _| {
            if done == 1 && inner.is_none() {
                inner = Some(notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {}));
            }
        })
        .unwrap();
    let inner = inner.expect("asked between two notes");
    assert!(
        matches!(&inner, Err(NotesError::TagRenameInProgress { from, to }) if from == "a" && to == "a/b"),
        "{inner:?}"
    );
    assert_eq!(renamed.written.len(), 3);
    for id in &ids {
        let text = e.read(&path_of(&e, id));
        assert!(
            text.contains("  - a/b\n") && text.contains("#a/b ") && !text.contains("a/b/b"),
            "{text}"
        );
        assert_eq!(record(&e, id, "tags"), ["a/b"]);
    }
}

/// A crash after a note's file took the rename, then a run that cannot edit that file (its
/// frontmatter broken outside): what the crashed run wrote stays marked, so once the file reads
/// again the same rename renames the record alone and the file once.
#[test]
fn a_note_the_rename_cannot_edit_keeps_what_a_stopped_run_wrote_to_it() {
    let (mut e, notes, _) = opened();
    let id = note(&notes, &e, "One", "#a one", &["a"]);
    let path = path_of(&e, &id);
    let open = e.session.current().unwrap();
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    let written = e.read(&path);
    assert!(written.contains("#a/b one"), "{written}");

    std::fs::write(e.vault.join(&path), "---\ntags: [a/b\n---\n#a/b one\n").unwrap();
    let kept = notes
        .rename_tag(&open, &job("a", "a/b"), &mut |_, _| {})
        .unwrap();
    assert_eq!(kept.failed_note_ids, std::slice::from_ref(&id));
    std::fs::write(e.vault.join(&path), &written).unwrap();
    std::thread::sleep(QUIET);
    e.drain();
    measured(&e, &id);

    let again = notes
        .rename_tag(&open, &job("a", "a/b"), &mut |_, _| {})
        .unwrap();
    assert_eq!(again.failed_note_ids, Vec::<String>::new());
    assert_eq!(e.read(&path), written, "the file renamed twice");
    assert_eq!(record(&e, &id, "tags"), ["a/b"]);
    assert!(plan(&e).is_none());
}

/// A crash after a note's file took the rename, then an outside edit adding a tag to its header,
/// which the record takes: the rename does not set the record back to the lists it had when the
/// file was begun; it leaves the note as edited and answers it.
#[test]
fn an_outside_header_edit_after_a_crash_keeps_its_tags_in_the_record() {
    let (e, notes, _) = opened();
    let id = note(&notes, &e, "One", "#a one", &["a"]);
    let path = path_of(&e, &id);
    let open = e.session.current().unwrap();
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    let edited = e.read(&path).replace("  - a/b\n", "  - a/b\n  - x\n");
    e.write(&path, &edited);
    until("the record took the outside edit", || {
        record(&e, &id, "tags") == ["a/b", "x"]
    });

    let renamed = notes
        .rename_tag(&open, &job("a", "a/b"), &mut |_, _| {})
        .unwrap();
    assert_eq!(renamed.failed_note_ids, std::slice::from_ref(&id));
    assert_eq!(e.read(&path), edited);
    assert_eq!(record(&e, &id, "tags"), ["a/b", "x"]);
    assert!(plan(&e).is_none());
}

/// A resume the vault close stops between two notes is no failure: it ends quietly, and the
/// rename stays recorded for the next open.
#[test]
fn a_resume_the_close_stops_leaves_the_rename_for_the_next_open() {
    let (e, notes, _) = opened();
    note(&notes, &e, "One", "#a one", &["a"]);
    note(&notes, &e, "Two", "#a two", &["a"]);
    let open = e.session.current().unwrap();
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");

    let resumed = notes.resume_tag_rename(&open, &|| true);
    assert!(matches!(resumed, Ok(None)), "{resumed:?}");
    assert_eq!(plan(&e).expect("still recorded").holders.len(), 2);
}

/// A resume with no rename recorded reads nothing under the device's identity: the device key
/// is minted by the first local write, never by an open.
#[test]
fn a_resume_with_no_rename_recorded_mints_no_device_key() {
    let (e, notes, store) = opened();
    std::thread::sleep(QUIET);
    // The test store starts with a key; this device has none yet.
    store.delete(SecureStoreKey::DeviceSigningKey).unwrap();
    let open = e.session.current().unwrap();
    let resumed = notes.resume_tag_rename(&open, &|| false);
    assert!(matches!(resumed, Ok(None)), "{resumed:?}");
    assert_eq!(store.get(SecureStoreKey::DeviceSigningKey).unwrap(), None);
}

/// A recorded rename the database fails to hand over is an error and stays recorded; only a
/// row that does not read as a rename (another layout) is dropped.
#[test]
fn a_rename_the_database_cannot_read_now_stays_recorded() {
    let (e, notes, _) = opened();
    note(&notes, &e, "One", "#a one", &["a"]);
    let open = e.session.current().unwrap();
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    let set = |sql: &'static str| {
        e.core()
            .db_handle()
            .call_blocking(move |conn| {
                conn.execute(sql, []).unwrap();
                Ok(())
            })
            .unwrap();
    };

    // A value of another type: the read fails, as a busy or failing database fails it.
    set("UPDATE meta SET value = CAST(value AS BLOB) WHERE key = 'tags.rename_job'");
    let failed = notes.resume_tag_rename(&open, &|| false);
    assert!(failed.is_err(), "{failed:?}");
    set("UPDATE meta SET value = CAST(value AS TEXT) WHERE key = 'tags.rename_job'");
    assert_eq!(plan(&e).expect("still recorded").holders.len(), 1);

    set(r#"UPDATE meta SET value = '{"from":"a"}' WHERE key = 'tags.rename_job'"#);
    let dropped = notes.resume_tag_rename(&open, &|| false);
    assert!(matches!(dropped, Ok(None)), "{dropped:?}");
    assert!(e.core().tag_rename_recorded().unwrap().is_none());
}

/// A rename left with a note it could not write names that note, and stopping it clears the
/// record: the note it wrote keeps the new name, the one it left the old, and another rename
/// runs. A running rename is neither reported as left nor stopped.
#[test]
fn a_rename_left_unfinished_names_its_notes_and_can_be_stopped() {
    let (e, notes, _) = opened();
    let ids = [
        note(&notes, &e, "One", "#a one", &["a"]),
        note(&notes, &e, "Two", "#a two", &["a"]),
    ];
    let open = e.session.current().unwrap();
    notes.fail_next_rename_edit();
    let mut during = None;
    let first = notes
        .rename_tag(&open, &job("a", "a/b"), &mut |done, _| {
            if done == 1 && during.is_none() {
                let left = notes.unfinished_tag_rename(&open);
                during = Some((left, notes.abandon_tag_rename(&open)));
            }
        })
        .unwrap();
    let (left, stopped) = during.expect("asked while it ran");
    assert!(matches!(left, Ok(None)), "{left:?}");
    assert!(
        matches!(&stopped, Err(NotesError::TagRenameInProgress { from, .. }) if from == "a"),
        "{stopped:?}"
    );
    let [failed] = &first.failed_note_ids[..] else {
        panic!("{first:?}")
    };
    let written = ids.iter().find(|id| *id != failed).unwrap();

    let unfinished = notes.unfinished_tag_rename(&open).unwrap().expect("left");
    assert_eq!(unfinished.left, 1);
    assert_eq!(
        (unfinished.job.from.as_str(), unfinished.job.to.as_str()),
        ("a", "a/b")
    );
    let named: Vec<(&str, &str)> = unfinished
        .notes
        .iter()
        .map(|note| (note.id.as_str(), note.title.as_str()))
        .collect();
    let title = if failed == &ids[0] { "One" } else { "Two" };
    assert_eq!(named, [(failed.as_str(), title)]);

    let stopped = notes.abandon_tag_rename(&open).unwrap();
    let stopped = stopped.expect("stopped");
    assert_eq!(stopped.job.to, "a/b");
    assert!(
        !stopped.renamed,
        "no record took the new name as it stopped"
    );
    assert!(plan(&e).is_none());
    assert!(notes.unfinished_tag_rename(&open).unwrap().is_none());
    assert_eq!(record(&e, failed, "tags"), ["a"]);
    assert!(e.read(&path_of(&e, failed)).contains("#a "));
    assert_eq!(record(&e, written, "tags"), ["a/b"]);
    let other = notes.rename_tag(&open, &job("a/b", "c"), &mut |_, _| {});
    assert_eq!(other.unwrap().written.len(), 1);
}

/// A crash after a day's body took the rename, then an outside edit adding a tag to its header,
/// which keeps the old name: the record took the change in the old name's terms, and the rename
/// gives it the new name and keeps the added tag.
#[test]
fn an_outside_header_edit_of_a_day_after_a_crash_keeps_its_tag_and_takes_the_new_name() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let day = NewDay {
        date: "2025-04-03".into(),
        content: "Walked #a".into(),
        tags: vec!["a".into()],
        ..NewDay::default()
    };
    let day = notes.create_day(&open, day).unwrap().id;
    measured(&e, &day);
    let path = path_of(&e, &day);
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    let text = e.read(&path);
    assert!(
        text.contains("Walked #a/b") && text.contains("  - a\n"),
        "{text}"
    );
    e.write(&path, &text.replace("  - a\n", "  - a\n  - x\n"));
    until("the record took the outside edit", || {
        record(&e, &day, "tags") == ["a", "x"]
    });

    let renamed = notes
        .rename_tag(&open, &job("a", "a/b"), &mut |_, _| {})
        .unwrap();
    assert_eq!(renamed.failed_note_ids, std::slice::from_ref(&day));
    assert_eq!(record(&e, &day, "tags"), ["a/b", "x"]);
    assert!(plan(&e).is_none());
}

/// Each note's turn reads whether the plan still lists its note: one struck off since the run
/// read the plan (its record and file renamed meanwhile) is not renamed again, so `a` to `a/b`
/// never makes `a/b/b` of it.
#[test]
fn a_note_struck_off_since_the_run_read_the_plan_is_not_renamed_again() {
    let (e, notes, store) = opened();
    for (title, text) in [("One", "#a one"), ("Two", "#a two")] {
        note(&notes, &e, title, text, &["a"]);
    }
    let open = e.session.current().unwrap();
    let hub = hub(&e, &store);
    let mut done_meanwhile = Vec::new();
    notes
        .rename_tag(&open, &job("a", "a/b"), &mut |done, _| {
            if done != 1 || !done_meanwhile.is_empty() {
                return;
            }
            for holder in plan(&e).expect("recorded").holders {
                assert!(hub.rename_in(&holder.id).unwrap());
                let renamed = NoteUpdateInput {
                    id: holder.id.clone(),
                    content: Some(e.body(&holder.id).replace("#a ", "#a/b ")),
                    header_tags: Some(HeaderTagEditInput {
                        add: Some(vec!["a/b".into()]),
                        remove: Some(vec!["a".into()]),
                        ..HeaderTagEditInput::default()
                    }),
                    ..NoteUpdateInput::default()
                };
                notes.update(&open, renamed).unwrap();
                done_meanwhile.push(holder.id);
            }
        })
        .unwrap();
    let [id] = &done_meanwhile[..] else {
        panic!("{done_meanwhile:?}")
    };
    let text = e.read(&path_of(&e, id));
    assert!(
        text.contains("  - a/b\n") && text.contains("#a/b ") && !text.contains("a/b/b"),
        "{text}"
    );
    assert_eq!(record(&e, id, "tags"), ["a/b"]);
}

/// A resume asked while a rename runs waits for it, then finishes what it left (a refused
/// rename holds the lock a moment too: a resume standing aside then would leave the rename
/// for the next open, refusing every other until then).
#[test]
fn a_resume_asked_while_a_rename_runs_waits_and_finishes_what_it_left() {
    let (e, notes, _) = opened();
    for (title, text) in [("One", "#a one"), ("Two", "#a two")] {
        note(&notes, &e, title, text, &["a"]);
    }
    let open = e.session.current().unwrap();
    notes.fail_next_rename_edit();
    let mut resume = None;
    let first = notes
        .rename_tag(&open, &job("a", "a/b"), &mut |done, _| {
            if done == 1 && resume.is_none() {
                let (notes, open) = (notes.clone(), open.clone());
                resume = Some(std::thread::spawn(move || {
                    notes.resume_tag_rename(&open, &|| false)
                }));
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        })
        .unwrap();
    assert_eq!(first.failed_note_ids.len(), 1, "{first:?}");
    let resumed = resume.expect("asked").join().unwrap().unwrap();
    let resumed = resumed.expect("it ran once the rename ended");
    assert_eq!(
        (resumed.written.len(), resumed.failed_note_ids),
        (1, Vec::new())
    );
    assert!(plan(&e).is_none());
}

/// A merge into a name the note holds (`a` to `b` of `[a, b]`) stopped after the file, then an
/// outside edit adding `x` to the header: the record keeps `b` and takes `x`.
#[test]
fn a_merge_stopped_after_the_file_then_edited_outside_keeps_the_merged_name() {
    let (e, notes, _) = opened();
    let id = note(&notes, &e, "One", "#a one", &["a", "b"]);
    let path = path_of(&e, &id);
    let open = e.session.current().unwrap();
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    let text = e.read(&path);
    assert!(
        text.contains("  - b\n") && !text.contains("  - a\n"),
        "{text}"
    );
    e.write(&path, &text.replace("  - b\n", "  - b\n  - x\n"));
    until("the record took the outside edit", || {
        record(&e, &id, "tags") == ["b", "x"]
    });

    notes
        .rename_tag(&open, &job("a", "b"), &mut |_, _| {})
        .unwrap();
    assert_eq!(record(&e, &id, "tags"), ["b", "x"]);
    assert!(plan(&e).is_none());
}

/// A rename stopped after a note's file and before its record, then stopped by the user: the
/// note's record takes the name its file holds, and the note it did not reach keeps the old.
#[test]
fn stopping_a_rename_renames_the_record_of_a_file_it_wrote() {
    let (e, notes, _) = opened();
    let ids = [
        note(&notes, &e, "One", "#a one", &["a"]),
        note(&notes, &e, "Two", "#a two", &["a"]),
    ];
    let open = e.session.current().unwrap();
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    let written = ids
        .iter()
        .find(|id| e.read(&path_of(&e, id)).contains("#a/b"))
        .expect("one file written");
    let other = ids.iter().find(|id| *id != written).unwrap();
    assert_eq!(record(&e, written, "tags"), ["a"]);

    let stopped = notes.abandon_tag_rename(&open).unwrap().expect("stopped");
    assert!(stopped.renamed);
    assert_eq!(record(&e, written, "tags"), ["a/b"]);
    assert_eq!(record(&e, other, "tags"), ["a"]);
    let left = e.read(&path_of(&e, other));
    assert!(!left.contains("#a/b") && left.contains("  - a\n"), "{left}");
    assert!(plan(&e).is_none());
}

/// Stopping while the lock is held a moment (a refused rename, a query): with nothing recorded
/// there is nothing to stop; with a rename recorded it is refused as running.
#[test]
fn stopping_with_nothing_recorded_is_nothing_while_the_lock_is_held() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    {
        let _held = notes.hold_tag_rename();
        assert!(matches!(notes.abandon_tag_rename(&open), Ok(None)));
    }
    note(&notes, &e, "One", "#a one", &["a"]);
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job("a", "a/b"), &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    let _held = notes.hold_tag_rename();
    let refused = notes.abandon_tag_rename(&open);
    assert!(
        matches!(&refused, Err(NotesError::TagRenameInProgress { from, .. }) if from == "a"),
        "{refused:?}"
    );
}

/// A resume that waited for the lock through a close writes nothing to the closing vault: the
/// recorded rename's shared part (a definition moved to the new name) is left to the next open.
#[test]
fn a_resume_stopped_while_it_waited_writes_nothing() {
    let (e, notes, store) = opened();
    note(&notes, &e, "One", "#a one", &["a"]);
    let hub = hub(&e, &store);
    hub.set_color("a", "#ff0000").unwrap();
    let open = e.session.current().unwrap();
    let holders = open.search.tag_rename_holders("a").unwrap();
    assert_eq!(hub.rename_begin(&job("a", "a/b"), holders).unwrap(), None);

    let held = notes.hold_tag_rename();
    let resume = {
        let (notes, open) = (notes.clone(), open.clone());
        std::thread::spawn(move || notes.resume_tag_rename(&open, &|| true))
    };
    std::thread::sleep(std::time::Duration::from_millis(200));
    drop(held);
    let resumed = resume.join().unwrap();
    assert!(matches!(resumed, Ok(None)), "{resumed:?}");
    let colors = open
        .search
        .tag_colors(vec!["a".into(), "a/b".into()])
        .unwrap();
    assert_eq!(colors, [Some("#ff0000".to_owned()), None]);
}

/// The tag list read as soon as the rename answers (the renderer's refetch on its event) counts
/// a body's `#tag` under the new name alone, before the vault reads the renamed file back.
#[test]
fn the_tag_list_read_when_the_rename_answers_counts_a_bodys_new_name_alone() {
    let (e, notes, _) = opened();
    let id = note(&notes, &e, "Two", "body #a/c two", &[]);
    let open = e.session.current().unwrap();
    let counts = || {
        let mut counts: Vec<(String, u32)> = open
            .search
            .tag_counts()
            .unwrap()
            .into_iter()
            .map(|tag| (tag.name, tag.count))
            .collect();
        counts.sort();
        counts
    };
    until("the bodies are read", || {
        counts() == [("a/c".to_owned(), 1)]
    });
    measured(&e, &id);

    notes
        .rename_tag(&open, &job("a", "b"), &mut |_, _| {})
        .unwrap();
    assert_eq!(counts(), [("b/c".to_owned(), 1)]);
}

/// A body-tag cache write that fails after the note's file and record took the new name leaves
/// the note renamed and counted as written: the cache is derived, and the read back of the file
/// writes it again.
#[test]
fn a_body_tag_cache_write_that_fails_leaves_the_note_renamed() {
    let (e, notes, _) = opened();
    let id = note(&notes, &e, "One", "#a one", &["a"]);
    let open = e.session.current().unwrap();
    notes.fail_next_rename_body_cache();
    let renamed = notes
        .rename_tag(&open, &job("a", "b"), &mut |_, _| {})
        .unwrap();
    assert_eq!(
        (renamed.written, renamed.failed_note_ids),
        (vec![id.clone()], vec![])
    );
    assert_eq!(record(&e, &id, "tags"), ["b"]);
    assert!(e.read(&path_of(&e, &id)).contains("#b one"));
}
