//! A generated vault for the note index tests (`indexer_scan`, `indexer_facts`).

#![allow(dead_code, reason = "each test binary uses a part of it")]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::index::{Indexer, TaskHandle, task_channel};
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

pub fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "still waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn all_indexed(e: &Env) -> bool {
    let search = e.session.current().expect("open").search;
    // The seeded paths are outside the journal folder: no day to compare.
    search.unindexed_notes(false, &|_| None).unwrap().is_empty()
}

/// Runs an index task of `open` beside the test, over `facts`, until the guard drops.
pub fn with_task(open: &OpenVault, facts: Receiver<Applied>, test: impl FnOnce(&TaskHandle)) {
    let indexer = Indexer::new(open);
    let cancel = CancelToken::default();
    let (handle, inbox) = task_channel();
    std::thread::scope(|scope| {
        scope.spawn(|| indexer.run(facts, inbox, &cancel).unwrap());
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
