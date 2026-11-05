//! A generated vault for the note index tests (`indexer_scan`, `indexer_facts`).

#![allow(dead_code, reason = "each test binary uses a part of it")]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::{IndexProgress, Indexer, OpenBuild, TaskHandle, task_channel};
use memry_desktop::session::OpenVault;
use memry_desktop::session::projection::CancelToken;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::rows::RowStat;
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::hash::content_hash;
use tokio::sync::broadcast::Receiver;

use crate::vault_env::{Env, WAIT, env};

pub fn note_text(i: usize) -> String {
    let mut text = String::new();
    if i.is_multiple_of(3) {
        text.push_str(&format!("---\ntags:\n  - topic{}\n  - Shared\n", i % 7));
        if i.is_multiple_of(5) {
            text.push_str("cover: wash:sage\n");
        }
        text.push_str("---\n");
    }
    text.push_str(&format!(
        "# Note {i}\n\nSome words about note {i} and [[Note {}]].\n",
        i + 1
    ));
    if i.is_multiple_of(4) {
        text.push_str("```\nlet skipped = true\n```\n");
    }
    if i.is_multiple_of(6) {
        text.push_str(&format!("- [ ] a task {{task:t{i}}}\n"));
    }
    text
}

pub fn path_of(i: usize) -> String {
    format!("f{}/Note {i}.md", i % 10)
}

/// A fully written note of about 2 KB, shaped like the `pnpm seed1k` vault's (Electron's
/// `seed-data/bulk-notes.ts`): frontmatter with tags and user properties, headings,
/// paragraphs, a list, a callout, a table, a code block, numbered and task lists, wiki links
/// and inline tags.
pub fn written_note_text(i: usize) -> String {
    let topic = ["design", "engineering", "research", "ops", "writing"][i % 5];
    let mut text = format!(
        "---\ntags:\n  - {topic}\n  - area{}\nstatus: active\npriority: low\nowner: Marta\nrating: {}\n---\n",
        i % 12,
        i % 5
    );
    text.push_str(&format!(
        "This is the working set of notes on {topic} item {i}. Nothing here is final yet.\n\n\
         ## Context\n\n\
         Kept a review checklist alongside this so the claim is checkable rather than \
         remembered. Left a note for the review so the next pass does not start from scratch. \
         It held up under a second read, which is more than the previous version managed.\n\n\
         - Prefer the boring option until there is a measurement that argues otherwise\n\
         - The sidebar animates a property that forces a repaint\n\
         - Produce an annotated screenshot set before the next review\n\
         - Revisit after two weeks of real use, not after one afternoon\n\n\
         ## Audit\n\n\
         The part worth remembering is that the surface is fine at the default size and \
         breaks at the largest one. Measured the count before and after; the difference was \
         large enough to keep the change.\n\n\
         > [!info]\n> The numbers here come from a single machine. Treat them as directional.\n\n\
         | Item | Owner | State |\n| --- | --- | --- |\n\
         | a spec | a fresh pair of eyes | review |\n\
         | a token table | the accessibility check | done |\n\
         | a screenshot set | the accessibility check | active |\n\n\
         ### Reference\n\n\
         ```css\n:root {{\n  --space-1: 4px;\n  --space-2: 8px;\n  --radius-card: 10px;\n}}\n```\n\n\
         ## Open questions\n\n\
         1. Does this still hold up in the right-to-left layout?\n\
         2. Which of these tokens is actually used more than once?\n\
         3. Is the restraint here reading as calm or as unfinished?\n\n\
         ## Next\n\n\
         - [x] Produce a spec before the next review\n\
         - [ ] Write down the assumption instead of re-deriving it every time\n\
         - [ ] Check with a fresh pair of eyes before changing the default\n\n\
         ## Links\n\n\
         - [[Note {}]]\n- [[Note {}]]\n- https://example.com/reference\n\n\
         #{topic} #area{}\n",
        (i + 1) % 1000,
        (i + 7) % 1000,
        i % 12
    ));
    text
}

/// A vault of `count` notes with their records and rows, as a closed app leaves it.
pub fn seeded(count: usize) -> (Env, Arc<dyn SecureStore>, Vec<(String, String)>) {
    let store = Mutex::new(None);
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s);
        None
    });
    let store = store.into_inner().unwrap().unwrap();
    for i in 0..count {
        e.write(&path_of(i), &note_text(i));
    }
    e.open();
    let core = e.core();
    let writer = core.notes_writer(store.clone()).unwrap();
    let rows = e.tier.rows();
    let session = rows.session_for(&core).unwrap();
    let mut notes = Vec::new();
    for i in 0..count {
        let (path, text) = (path_of(i), note_text(i));
        let id = writer
            .create(format!("Note {i}"), Some(format!("f{}", i % 10)))
            .unwrap();
        let hash = content_hash(&text);
        // Both hashes name the file, as an indexed vault's rows do, so the open walk reads
        // nothing: what is measured below is the index alone.
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: text.len() as u64,
            content_hash: Some(hash.clone()),
            file_hash: Some(hash),
        };
        rows.reserve(session, &id, &path, stat).unwrap();
        notes.push((id, path));
    }
    e.close();
    (e, store, notes)
}

/// A vault of `count` files the app has never seen, `text(i)` at [`path_of`]`(i)`, its files
/// named by the notes identity.
pub fn fresh(count: usize, text: fn(usize) -> String) -> Env {
    let e = env(|store| Some(NotesIdentity::new(store)));
    for i in 0..count {
        e.write(&path_of(i), &text(i));
    }
    e
}

pub fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "still waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn all_indexed(e: &Env) -> bool {
    let search = e.session.current().expect("open").search;
    search.unindexed_notes(false).unwrap().is_empty()
}

/// Runs an index task of `open` beside the test, over `facts`, until the guard drops.
pub fn with_task(open: &OpenVault, facts: Receiver<Applied>, test: impl FnOnce(&TaskHandle)) {
    with_reporting_task(open, facts, &|_| {}, test);
}

/// [`with_task`] whose open's pass progress goes to `report`.
pub fn with_reporting_task(
    open: &OpenVault,
    facts: Receiver<Applied>,
    report: &(dyn Fn(IndexProgress) + Sync),
    test: impl FnOnce(&TaskHandle),
) {
    // A store of its own: the index reads the definitions' records under it, writing none.
    with_task_under(
        open,
        facts,
        crate::device_key::with_device_key(),
        report,
        test,
    );
}

/// [`with_reporting_task`] whose task reads records under `store`.
pub fn with_task_under(
    open: &OpenVault,
    facts: Receiver<Applied>,
    store: Arc<dyn SecureStore>,
    report: &(dyn Fn(IndexProgress) + Sync),
    test: impl FnOnce(&TaskHandle),
) {
    let indexer = Indexer::new(open, store);
    let cancel = CancelToken::default();
    let (handle, inbox) = task_channel();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            indexer
                .run(
                    facts,
                    inbox,
                    &cancel,
                    &|build| {
                        if let OpenBuild::Step(step) = build {
                            report(step);
                        }
                    },
                    &|_| {},
                    &|_| {},
                )
                .unwrap()
        });
        // Stopped on the way out, a failed wait included, so the scope can join the task.
        let _stop = StopOnDrop(&handle, &cancel);
        test(&handle);
    });
}

struct StopOnDrop<'a>(&'a TaskHandle, &'a CancelToken);

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        self.1.cancel();
        self.0.stop();
    }
}
