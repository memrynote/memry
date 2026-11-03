//! The app-edit seam (`vault::app_edit`, #3530 13g-2) over a real session, tier, watcher and
//! index: what `Held` replaces and what it keeps, a text the document does not take reaching it
//! through the watcher, and the byte order mark.

use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::frontmatter::{parse_markdown_note, split_frontmatter_block};
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::markdown::shared::writing_tools::writing_of_yaml;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::write_order::WriteOrder;
use memry_desktop::vault::app_edit::{AppEdit, Edited, Kept, Precondition};
use memry_desktop::vault::consumer::ChangeSource;
use memry_desktop::vault::hash::content_hash;

use crate::index_support::until;
use crate::notes_link_rewrite::{changes, id_at, opened, row_hash};
use crate::vault_env::Env;

const BOM: char = '\u{feff}';

/// The note's file, edited through the seam in a turn of its own.
fn run(
    edit: &AppEdit,
    id: &str,
    precondition: Precondition,
    source: ChangeSource,
    next: impl FnOnce(&str) -> Option<String>,
) -> Edited {
    WriteOrder::default()
        .run(id, |turn| {
            edit.run(turn, precondition, source, |text| {
                Ok::<_, NotesError>(next(text))
            })
        })
        .unwrap()
}

fn file_hash(e: &Env, id: &str) -> Option<String> {
    e.core().note_files().by_id(id).unwrap().unwrap().file_hash
}

#[test]
fn held_keeps_a_file_the_document_does_not_hold() {
    let (e, _, store) = opened(&[("Ideas.md", "See [[Plan]].\n")]);
    let open = e.session.current().unwrap();
    let ideas = id_at(&e, "Ideas.md");
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    let held = |text: &'static str| {
        run(
            &edit,
            &ideas,
            Precondition::Held,
            ChangeSource::AppEdit,
            |_| Some(text.to_owned()),
        )
    };

    // An edit that would leave a frontmatter that does not parse.
    assert_eq!(
        held("---\na: [\n---\nSee [[Roadmap]].\n"),
        Edited::Kept(Kept::FrontmatterBroken)
    );
    assert_eq!(e.read("Ideas.md"), "See [[Plan]].\n");

    // The document is ahead of its file: an edit in the app the write-back has not written.
    e.edit_in_app(&store, &ideas, "Edited in the app");
    assert_eq!(held("See [[Roadmap]].\n"), Edited::Kept(Kept::BodyAhead));
    assert_eq!(e.read("Ideas.md"), "See [[Plan]].\n");
    assert_eq!(e.body(&ideas), "Edited in the app");

    // The file is not the one its row names: an outside edit the note has not taken.
    e.core()
        .note_files()
        .set_hash(&ideas, Some("not-the-file"))
        .unwrap();
    assert_eq!(held("See [[Roadmap]].\n"), Edited::Kept(Kept::FileChanged));
    assert_eq!(e.read("Ideas.md"), "See [[Plan]].\n");
}

const WRITING: &str = "---\nwriting:\n  alternatives:\n    k3x9q2:\n      versions:\n        \
                       - text: two\n        - text: zwei\n---\n\
                       one <!--alt:k3x9q2-->two<!--/alt:k3x9q2--> three\n";

#[test]
fn held_keeps_a_file_whose_writing_data_the_document_is_ahead_of() {
    let (e, _, store) = opened(&[("Alt.md", WRITING)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Alt.md");
    // The document takes other alternatives for the same text (a merge from sync, say); the
    // file still says the old ones.
    let other = WRITING.replace("zwei", "drei");
    let split = split_frontmatter_block(&other);
    let input = FeedInput {
        note_id: &id,
        markdown: split.body,
        note_path: Some("Alt.md"),
        writing: Some(writing_of_yaml(
            &parse_markdown_note(&other).unwrap().frontmatter,
        )),
        frontmatter: split.block,
        embeds: None,
    };
    let converter = Converter::new(CalloutTypes::new(Vec::new()));
    let feed = open.vault.external_feed(store.clone()).unwrap();
    assert_eq!(feed.feed(&converter, input).unwrap(), FeedOutcome::Fed);

    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    let done = run(
        &edit,
        &id,
        Precondition::Held,
        ChangeSource::AppEdit,
        |text| Some(text.replace("three", "four")),
    );
    assert_eq!(done, Edited::Kept(Kept::BodyAhead));
    assert_eq!(e.read("Alt.md"), WRITING);
}

#[test]
fn held_edit_lands_in_the_document_the_file_and_the_row_with_one_byte_order_mark() {
    let file = format!("{BOM}---\nkeep: 'as is'\n---\nSee [[Plan]].\n");
    let (mut e, _, store) = opened(&[("Ideas.md", &file)]);
    let open = e.session.current().unwrap();
    let ideas = id_at(&e, "Ideas.md");
    e.drain();
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    let done = run(
        &edit,
        &ideas,
        Precondition::Held,
        ChangeSource::App,
        |text| {
            assert!(!text.starts_with(BOM), "the closure sees no mark");
            Some(text.replace("]].", "]] and more."))
        },
    );
    let text = format!("{BOM}---\nkeep: 'as is'\n---\nSee [[Plan]] and more.\n");
    assert_eq!(
        done,
        Edited::Wrote {
            hash: content_hash(&text),
            held: true
        }
    );
    assert_eq!(e.read("Ideas.md"), text);
    assert_eq!(e.body(&ideas), "See [[Plan]] and more.");
    assert_eq!(row_hash(&e, &ideas), Some(content_hash(&text)));
    // No version of the body the edit replaced: it was the file's.
    assert!(e.versions(&ideas).is_empty());
    assert_eq!(
        changes(&mut e),
        [("Ideas.md".to_owned(), ChangeSource::App)]
    );

    // A text handed back with its own mark gets no second one.
    run(
        &edit,
        &ideas,
        Precondition::Held,
        ChangeSource::App,
        |text| Some(format!("{BOM}{}", text.replace("more", "less"))),
    );
    assert_eq!(
        e.read("Ideas.md"),
        format!("{BOM}---\nkeep: 'as is'\n---\nSee [[Plan]] and less.\n")
    );
    // Nothing to change is no write.
    let none = run(&edit, &ideas, Precondition::Held, ChangeSource::App, |_| {
        None
    });
    assert_eq!(none, Edited::Unchanged);
}

#[test]
fn a_text_the_document_does_not_take_is_written_and_brought_in_by_the_watcher() {
    let (e, _, store) = opened(&[("Big.md", "Small.\n")]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Big.md");
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    // A run of 128 KB with no blank line is large-file class: no update carries it.
    let big = format!("{}\n", "a".repeat(130 * 1024));
    let done = run(
        &edit,
        &id,
        Precondition::Held,
        ChangeSource::AppEdit,
        |_| Some(big.clone()),
    );
    assert_eq!(
        done,
        Edited::Wrote {
            hash: content_hash(&big),
            held: false
        }
    );
    assert_eq!(e.read("Big.md"), big);
    // No own-write record absorbs the write: the watcher reports it, so the consumer takes the
    // file as it takes an outside edit (and retries a feed that failed), and records its bytes.
    until("the watcher brought the file in", || {
        file_hash(&e, &id) == Some(content_hash(&big))
    });
    assert_eq!(row_hash(&e, &id), Some(content_hash("Small.\n")));
}
