//! The note index announces the links a pass committed (`NoteLinksChangedEvent`, #3530 13i),
//! over a real session, tier, watcher and index. A note event goes out when a file's row
//! changes, before the index writes the file's links; this goes out after, so a links panel
//! that refetches on it reads the links the edit made.
//!
//! - An outside edit that adds a link, then one that removes it: each is announced with the
//!   source and the target, and a read on the announcing thread already sees the change.
//! - A link to a note that does not exist yet, then the note: the link resolves to it, and the
//!   new note is announced as a target.
//! - An edit that changes no link announces nothing.

mod device_key;
mod index_support;
mod vault_env;

use std::collections::BTreeMap;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use index_support::until;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::{LinkChanges, NoteIndex};
use memry_desktop::notes::links::NoteLinks;
use vault_env::{WAIT, env, indexed};

/// An announcement, and each announced target's backlinks (source titles) read when it came.
type Announced = (LinkChanges, BTreeMap<String, Vec<String>>);

/// The first announcement naming `source` as changed, and those before it, each of which
/// changed some link.
fn announced_for(heard: &Receiver<Announced>, source: &str) -> (Announced, Vec<LinkChanges>) {
    let deadline = Instant::now() + WAIT;
    let mut before = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let (changes, seen) = heard
            .recv_timeout(left)
            .unwrap_or_else(|_| panic!("no announcement for {source}"));
        assert!(!changes.is_empty(), "an announcement that changed nothing");
        if changes.sources.contains(source) {
            return ((changes, seen), before);
        }
        before.push(changes);
    }
}

#[test]
fn the_links_an_edit_changed_are_announced_once_they_read_back() {
    let mut e = env(|s| Some(NotesIdentity::new(s)));
    e.write("Target.md", "# Target\n");
    e.write("Early.md", "See [[Target]].\n");
    e.write("Late.md", "Nothing yet.\n");
    let reader: Arc<Mutex<Option<NoteLinks>>> = Arc::default();
    let (tell, heard) = mpsc::channel::<Announced>();
    let tell = Mutex::new(tell);
    let slot = reader.clone();
    let index = NoteIndex::new(
        e.tier.clone(),
        |_| {},
        move |changes: LinkChanges| {
            // What a refetch sent on the event reads.
            let seen = slot.lock().unwrap().as_ref().map(|links| {
                changes
                    .targets
                    .iter()
                    .map(|id| {
                        let incoming = links.get(id).unwrap().incoming;
                        let titles = incoming.into_iter().map(|b| b.source_title).collect();
                        (id.clone(), titles)
                    })
                    .collect()
            });
            // The test may have ended.
            let _ = tell
                .lock()
                .unwrap()
                .send((changes, seen.unwrap_or_default()));
        },
    );
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let id_at = |path: &str| -> String {
        e.rows()
            .into_iter()
            .find(|(_, p)| p == path)
            .unwrap_or_else(|| panic!("no row at {path}"))
            .0
    };
    let (target, early, late) = (id_at("Target.md"), id_at("Early.md"), id_at("Late.md"));
    let links = NoteLinks::new(&e.session.current().unwrap());
    until("the open's links indexed", || {
        links.get(&target).unwrap().incoming.len() == 1
    });
    *reader.lock().unwrap() = Some(NoteLinks::new(&e.session.current().unwrap()));

    e.write("Late.md", "Now about [[Target]] too.\n");
    let ((changes, seen), _) = announced_for(&heard, &late);
    assert!(changes.targets.contains(&target), "{changes:?}");
    assert_eq!(seen[&target], ["Early", "Late"]);

    e.write("Late.md", "Gone again.\n");
    let ((changes, seen), _) = announced_for(&heard, &late);
    assert!(changes.targets.contains(&target), "{changes:?}");
    assert_eq!(seen[&target], ["Early"]);

    // An edit that changes no link announces nothing: the next announcement is Early's.
    let words = "Other words, still no link.\n";
    e.write("Late.md", words);
    // Full text commits with the links, in the pass a changed link would be announced from.
    let search = e.session.current().unwrap().search;
    until("the link-free edit indexed", || {
        let hits = search.notes("still".into(), 5).unwrap();
        hits.iter().any(|hit| hit.id == late)
    });

    // A forward link resolves once its note exists: the new note gained a backlink.
    e.write("Early.md", "See [[Target]] and [[Ghost]].\n");
    let ((changes, _), before) = announced_for(&heard, &early);
    // The link-free edit's pass came first and announced nothing for Late.
    assert!(
        before.iter().all(|other| !other.sources.contains(&late)),
        "{before:?}"
    );
    assert!(!changes.targets.contains(&target), "{changes:?}");
    e.write("Ghost.md", "# Ghost\n");
    let ghost = {
        let mut found = None;
        until("the ghost's row", || {
            found = e
                .rows()
                .into_iter()
                .find(|(_, p)| p == "Ghost.md")
                .map(|r| r.0);
            found.is_some()
        });
        found.unwrap()
    };
    let ((changes, seen), _) = announced_for(&heard, &early);
    assert!(changes.targets.contains(&ghost), "{changes:?}");
    assert_eq!(seen[&ghost], ["Early"]);
    drop(links);
    *reader.lock().unwrap() = None;
    e.close();
}
