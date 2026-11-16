//! A new note's body `#tag` reaches the tag lists (#4732, REVIEW-4743). Create mints only its
//! header tags, as Electron's `createNote` mints the template's and the input's: its body tags
//! are not indexed when create answers, so the list the create's `notes:tags-changed` makes the
//! renderer read lacks them, and the index pass that indexes them must mint them and report
//! `TagsDefined` so the renderer reads the list again.

#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::{IndexReport, NoteIndex};
use memry_desktop::notes::service::NotesService;
use vault_env::{QUIET, env, indexed};

#[test]
fn a_new_notes_body_tag_reaches_the_tag_lists() {
    let defined = Arc::new(AtomicUsize::new(0));
    let counter = defined.clone();
    let mut store = None;
    let mut e = env(|s| {
        store = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    NoteIndex::new(
        e.tier.clone(),
        move |report| {
            if report == IndexReport::TagsDefined {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        },
        |_| {},
        |_| {},
    )
    .register(&e.session);
    let notes = NotesService::new(e.tier.clone(), store.unwrap());
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(QUIET);
    let before = defined.load(Ordering::SeqCst);

    let open = e.session.current().unwrap();
    let note = NewNoteFile {
        title: "Plan".into(),
        content: "About #fresh".into(),
        tags: vec!["plan".into()],
        ..NewNoteFile::default()
    };
    notes.create(&open, note).unwrap();
    // What the renderer reads on the create's `notes:tags-changed`.
    let listed = open.search.tag_counts().unwrap();
    std::thread::sleep(QUIET * 2);

    let fresh_listed = listed.iter().any(|tag| tag.name == "fresh");
    let reread = defined.load(Ordering::SeqCst) > before;
    assert!(
        fresh_listed || reread,
        "#fresh is missing from the lists: not read at create ({listed:?}), no TagsDefined after"
    );
}
