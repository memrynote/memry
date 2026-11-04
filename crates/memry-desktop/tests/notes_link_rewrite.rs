//! The links to a note follow its rename and its move (Step 13g-2, #3530), over a real
//! session, tier, watcher and index: each linking file is rewritten in place, frontmatter
//! included, its note's document takes the new text, its row the new hash, and the renderer is
//! told as for an outside edit; the watcher reports none of it back. The seam itself is
//! `app_edit.rs`.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::links::NoteLinks;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use vault_env::{Env, QUIET, env, indexed};

/// An open vault over `files`, its first walk and index pass done, with the notes service and
/// the store.
pub(crate) fn opened(files: &[(&str, &str)]) -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (rel, text) in files {
        e.write(rel, text);
    }
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {}).register(&e.session);
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    (e, notes, store)
}

pub(crate) fn id_at(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .unwrap_or_else(|| panic!("no row at {path}"))
        .0
}

pub(crate) fn row_hash(e: &Env, id: &str) -> Option<String> {
    e.core()
        .note_files()
        .by_id(id)
        .unwrap()
        .unwrap()
        .content_hash
}

/// The `Changed` facts of the next quiet spell, by source.
pub(crate) fn changes(e: &mut Env) -> Vec<(String, ChangeSource)> {
    std::thread::sleep(QUIET);
    e.drain()
        .into_iter()
        .filter_map(|fact| match fact {
            Applied::Changed { path, source, .. } => Some((path, source)),
            _ => None,
        })
        .collect()
}

const IDEAS: &str = "---\ntags: [x]\nrelated: \"[[Plan]]\"\n---\n\
See [[Plan]], [[plan#Goals|the goals]] and [[Other]].\n\nAlso [[work/Plan]].\n";

#[test]
fn a_rename_and_a_move_repair_the_links_in_every_file() {
    let (mut e, notes, _) = opened(&[
        ("work/Plan.md", "Back to [[Plan]].\n"),
        ("Ideas.md", IDEAS),
        ("Other.md", "Nothing to see.\n"),
    ]);
    let open = e.session.current().unwrap();
    let (plan, ideas) = (id_at(&e, "work/Plan.md"), id_at(&e, "Ideas.md"));
    let links = NoteLinks::new(&open);
    until("the links indexed", || {
        links.get(&plan).unwrap().incoming.len() == 1
    });
    e.drain();

    notes.rename(&open, &plan, "Roadmap").unwrap();

    let expected = "---\ntags: [x]\nrelated: \"[[Roadmap]]\"\n---\n\
See [[Roadmap]], [[Roadmap#Goals|the goals]] and [[Other]].\n\nAlso [[work/Roadmap]].\n";
    assert_eq!(e.read("Ideas.md"), expected);
    assert_eq!(e.read("work/Roadmap.md"), "Back to [[Roadmap]].\n");
    assert_eq!(e.read("Other.md"), "Nothing to see.\n");
    // The documents hold the files' text.
    assert_eq!(
        e.body(&ideas),
        "See [[Roadmap]], [[Roadmap#Goals|the goals]] and [[Other]].\nAlso [[work/Roadmap]]."
    );
    assert_eq!(e.body(&plan), "Back to [[Roadmap]].");
    assert_eq!(row_hash(&e, &ideas), Some(content_hash(expected)));
    // The app's edits, told as edits for the user; none came back from the watcher.
    let mut seen = changes(&mut e);
    seen.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        seen,
        [
            ("Ideas.md".to_owned(), ChangeSource::AppEdit),
            ("work/Roadmap.md".to_owned(), ChangeSource::AppEdit),
        ]
    );

    // A move changes no title: only the path link follows it.
    until("the rewritten links indexed", || {
        let outgoing = links.get(&ideas).unwrap().outgoing;
        outgoing
            .iter()
            .any(|link| link.target_title == "work/Roadmap")
    });
    notes.move_to_folder(&open, &plan, "archive").unwrap();
    assert_eq!(
        e.read("Ideas.md"),
        expected.replace("[[work/Roadmap]]", "[[archive/Roadmap]]")
    );
    assert_eq!(e.read("archive/Roadmap.md"), "Back to [[Roadmap]].\n");
}

/// A title the frontmatter's quoting cannot hold as written (`'` in a single-quoted value): the
/// value is written as YAML writes it, every other line kept, and the body follows too.
#[test]
fn a_title_with_a_quote_follows_in_the_frontmatter_and_the_body() {
    let (e, notes, _) = opened(&[
        ("Plan.md", "The plan.\n"),
        (
            "Ideas.md",
            "---\n# mine\nrelated: '[[Plan]]'\ntags: [x]\n---\nSee [[Plan]].\n",
        ),
    ]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Plan.md");
    let links = NoteLinks::new(&open);
    until("the links indexed", || {
        links.get(&plan).unwrap().incoming.len() == 1
    });

    notes.rename(&open, &plan, "Kaan's Plan").unwrap();

    assert_eq!(
        e.read("Ideas.md"),
        "---\n# mine\nrelated: '[[Kaan''s Plan]]'\ntags: [x]\n---\nSee [[Kaan's Plan]].\n"
    );
}
