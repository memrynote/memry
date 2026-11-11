//! The app-edit seam (`vault::app_edit`, #3530 13g-2) over a real session, tier, watcher and
//! index: what `Held` replaces and what it keeps, a text the document does not take reaching it
//! through the watcher (a feed that fails included), and the byte order mark.

use memry_core::api::editor::ReadOnly;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::frontmatter::{parse_markdown_note, split_frontmatter_block};
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::markdown::shared::markdown_class::{NOTE_MAX_BLOCK_BYTES, NOTE_MAX_BYTES};
use memry_core::markdown::shared::writing_tools::writing_of_yaml;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::write_order::WriteOrder;
use memry_desktop::vault::app_edit::{AppEdit, Edited, Kept, OwnFiles, Precondition};
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

/// The resident editor (Step 14) stores a window's typing outside the note's turn. Typing that
/// lands after the seam compared the document keeps the file: the edit is kept, the typing stays
/// the body, and no version is taken of it.
#[test]
fn held_keeps_the_file_when_typing_lands_after_the_document_was_compared() {
    let (e, _, store) = opened(&[("Ideas.md", "See [[Plan]].\n")]);
    let open = e.session.current().unwrap();
    let ideas = id_at(&e, "Ideas.md");
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    let versions = e.versions(&ideas);

    let done = run(
        &edit,
        &ideas,
        Precondition::Held,
        ChangeSource::AppEdit,
        |_| {
            e.edit_in_app(&store, &ideas, "Typed meanwhile");
            Some("See [[Roadmap]].\n".to_owned())
        },
    );

    assert_eq!(done, Edited::Kept(Kept::BodyAhead));
    assert_eq!(e.read("Ideas.md"), "See [[Plan]].\n");
    assert_eq!(e.body(&ideas), "Typed meanwhile");
    assert_eq!(e.versions(&ideas), versions);
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
            held: true,
            kept_outside: false,
            kept: None,
            text: text.clone()
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
    assert_eq!(
        none,
        Edited::Unchanged {
            text: format!("{BOM}---\nkeep: 'as is'\n---\nSee [[Plan]] and less.\n")
        }
    );
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
            held: false,
            kept_outside: false,
            kept: None,
            text: big.clone()
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

#[test]
fn a_save_whose_feed_fails_is_written_and_brought_in_by_the_watcher() {
    let (e, _, store) = opened(&[("Plan.md", "First text.\n")]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    edit.fail_next_feed();
    let own = OwnFiles::default();
    let saved = "Second text.\n";
    // Read under the lane, after the write and before the watcher can report it.
    let mut row_at_landing = None;
    let done = WriteOrder::default()
        .run(&id, |turn| {
            edit.run_then(
                turn,
                Precondition::Save(&own, None),
                ChangeSource::Save,
                |_| Ok::<_, NotesError>(Some(saved.to_owned())),
                || {
                    row_at_landing = Some(row_hash(&e, &id));
                    Ok(false)
                },
                &mut || {},
            )
        })
        .unwrap();
    assert_eq!(
        done,
        Edited::Wrote {
            hash: content_hash(saved),
            held: false,
            kept_outside: false,
            kept: Some(content_hash("First text.\n")),
            text: saved.to_owned()
        }
    );
    assert_eq!(e.read("Plan.md"), saved);
    assert_eq!(
        row_at_landing,
        Some(Some(content_hash("First text.\n"))),
        "the row named a file the document does not hold"
    );
    // No own-write record absorbs the write: the watcher reports it and the consumer feeds it.
    until("the watcher fed the saved file", || {
        e.body(&id) == "Second text." && row_hash(&e, &id) == Some(content_hash(saved))
    });
}

/// A save whose feed fails toggles the file back to an earlier save that is still pending in the
/// own-write record, with a later save pending after it (#4222): only the toggled save's hash
/// leaves the record, so the watcher reports the file and the consumer feeds it. Ending the
/// newest pending write instead left the earlier one to absorb the file, and the document kept
/// the later save's text.
#[test]
fn a_failed_feed_back_to_an_earlier_pending_save_is_brought_in_by_the_watcher() {
    let (e, _, store) = opened(&[("Plan.md", "First text.\n")]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let first = "First text.\n";
    let second = "Second text.\n";
    e.write("Plan.md", second);
    until("the watcher fed the second text", || {
        e.body(&id) == "Second text." && row_hash(&e, &id) == Some(content_hash(second))
    });
    // Two saves recorded and not seen yet, the first save's then the second's.
    let echo = e.tier.echo();
    echo.will_write("Plan.md", &content_hash(first));
    echo.will_write("Plan.md", &content_hash(second));

    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    edit.fail_next_feed();
    let own = OwnFiles::default();
    let done = run(
        &edit,
        &id,
        Precondition::Save(&own, None),
        ChangeSource::Save,
        |_| Some(first.to_owned()),
    );
    assert!(
        matches!(done, Edited::Wrote { held: false, .. }),
        "{done:?}"
    );
    assert_eq!(e.read("Plan.md"), first);
    until("the watcher fed the file back", || {
        e.body(&id) == "First text." && row_hash(&e, &id) == Some(content_hash(first))
    });
}

/// The app's own write records its file's class (#3531 14c-2): the watcher skips the echo, so
/// no read of it would. A save grown past the ceiling by its frontmatter alone opens read-only
/// at once.
#[test]
fn a_save_grown_past_the_ceiling_by_its_frontmatter_opens_read_only() {
    let (e, _, store) = opened(&[("Plan.md", "Small.\n")]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    let own = OwnFiles::default();
    let big = format!("---\nnotes: {}\n---\nSmall.\n", "a".repeat(NOTE_MAX_BYTES));

    let done = run(
        &edit,
        &id,
        Precondition::Save(&own, None),
        ChangeSource::Save,
        |_| Some(big.clone()),
    );
    assert!(matches!(done, Edited::Wrote { .. }), "{done:?}");
    let editor = open.vault.editor(store).unwrap();
    assert_eq!(
        editor.open(&id, "main").unwrap().read_only,
        Some(ReadOnly::LargeFile)
    );
}

/// A save that shrinks a large file makes it a note again, and the next open's walk, which
/// skips a file its row names, leaves it so.
#[test]
fn a_save_that_shrinks_a_large_file_makes_it_a_note_across_a_reopen() {
    let (mut e, _, store) = opened(&[("Log.md", "a note\n")]);
    let id = id_at(&e, "Log.md");
    let large = |e: &Env| e.core().note_files().is_large_file(&id).unwrap();
    // A note's file grown outside past the block bound (a file that was never a note is not
    // taken for one).
    e.write(
        "Log.md",
        &format!("{}\n", "x".repeat(NOTE_MAX_BLOCK_BYTES + 1)),
    );
    until("the watcher measured it", || large(&e));
    let open = e.session.current().unwrap();
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    let own = OwnFiles::default();

    let done = run(
        &edit,
        &id,
        Precondition::Save(&own, None),
        ChangeSource::Save,
        |_| Some("small now\n".to_owned()),
    );
    assert!(matches!(done, Edited::Wrote { .. }), "{done:?}");
    assert!(!large(&e));
    drop((edit, open));
    e.close();
    e.open();
    e.facts_until(crate::vault_env::indexed);
    assert!(!large(&e), "the reopen keeps the class");
    let editor = e.core().editor(store).unwrap();
    assert_eq!(editor.open(&id, "main").unwrap().read_only, None);
}
