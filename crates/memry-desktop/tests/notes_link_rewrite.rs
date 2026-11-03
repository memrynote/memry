//! The links to a note follow its rename and its move (Step 13g-2, #3530), over a real
//! session, tier, watcher and index: each linking file is rewritten in place, frontmatter
//! included, its note's document takes the new text, its row the new hash, and the renderer is
//! told as for an outside edit; the watcher reports none of it back. The app-edit seam
//! (`vault::app_edit`) keeps a file the note does not hold as it is: an outside edit not fed
//! yet, a document ahead of its file, an edit that would break the frontmatter.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::links::NoteLinks;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::app_edit::{AppEdit, Edited, Kept};
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use vault_env::{Env, QUIET, env, indexed};

/// An open vault over `files`, its first walk and index pass done, with the notes service and
/// the store.
fn opened(files: &[(&str, &str)]) -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (rel, text) in files {
        e.write(rel, text);
    }
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}).register(&e.session);
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    (e, notes, store)
}

fn id_at(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .unwrap_or_else(|| panic!("no row at {path}"))
        .0
}

fn row_hash(e: &Env, id: &str) -> Option<String> {
    e.core()
        .note_files()
        .by_id(id)
        .unwrap()
        .unwrap()
        .content_hash
}

/// The `Changed` facts of the next quiet spell, by source.
fn changes(e: &mut Env) -> Vec<(String, ChangeSource)> {
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

#[test]
fn a_file_the_note_does_not_hold_keeps_its_text() {
    let (e, _, store) = opened(&[("Ideas.md", "See [[Plan]].\n")]);
    let open = e.session.current().unwrap();
    let ideas = id_at(&e, "Ideas.md");
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    let run = |text: &'static str| -> Edited {
        edit.run(&ideas, ChangeSource::AppEdit, |_| {
            Ok::<_, NotesError>(Some(text.to_owned()))
        })
        .unwrap()
    };

    // An edit that would leave a frontmatter that does not parse.
    assert_eq!(
        run("---\na: [\n---\nSee [[Roadmap]].\n"),
        Edited::Kept(Kept::FrontmatterBroken)
    );
    assert_eq!(e.read("Ideas.md"), "See [[Plan]].\n");

    // The document is ahead of its file: an edit in the app the write-back has not written.
    e.edit_in_app(&store, &ideas, "Edited in the app");
    assert_eq!(run("See [[Roadmap]].\n"), Edited::Kept(Kept::BodyAhead));
    assert_eq!(e.read("Ideas.md"), "See [[Plan]].\n");
    assert_eq!(e.body(&ideas), "Edited in the app");

    // The file is not the one its row names: an outside edit the note has not taken.
    e.core()
        .note_files()
        .set_hash(&ideas, Some("not-the-file"))
        .unwrap();
    assert_eq!(run("See [[Roadmap]].\n"), Edited::Kept(Kept::FileChanged));
    assert_eq!(e.read("Ideas.md"), "See [[Plan]].\n");
}

#[test]
fn an_edit_lands_in_the_file_the_document_and_the_row() {
    let (mut e, _, store) = opened(&[("Ideas.md", "---\nkeep: 'as is'\n---\nSee [[Plan]].\n")]);
    let open = e.session.current().unwrap();
    let ideas = id_at(&e, "Ideas.md");
    e.drain();
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    let text = "---\nkeep: 'as is'\n---\nSee [[Plan]] and more.\n";
    let done = edit
        .run(&ideas, ChangeSource::App, |file| {
            Ok::<_, NotesError>(Some(file.raw.replace("]].", "]] and more.")))
        })
        .unwrap();
    assert_eq!(
        done,
        Edited::Wrote {
            hash: content_hash(text),
            held: true
        }
    );
    assert_eq!(e.read("Ideas.md"), text);
    assert_eq!(e.body(&ideas), "See [[Plan]] and more.");
    assert_eq!(row_hash(&e, &ideas), Some(content_hash(text)));
    // No version of the body the edit replaced: it was the file's.
    assert!(e.versions(&ideas).is_empty());
    assert_eq!(
        changes(&mut e),
        [("Ideas.md".to_owned(), ChangeSource::App)]
    );
    // Nothing to change is no write.
    let none = edit.run(&ideas, ChangeSource::App, |_| Ok::<_, NotesError>(None));
    assert_eq!(none.unwrap(), Edited::Unchanged);
}
