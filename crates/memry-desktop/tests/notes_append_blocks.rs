//! Blocks moved into another note (`notes:append-blocks`, #4181), after Electron's
//! `appendBlocksToNote`, on a real vault under the running tier, its watcher and an editor
//! host: the target's file, its document, its row, the windows showing it, and the source.
//!
//! | Test                                                              | Rule                                      |
//! | ----------------------------------------------------------------- | ----------------------------------------- |
//! | a closed target takes the blocks after a blank line               | `head\n\n${markdown.trim()}`, block kept  |
//! | refs are resolved from the source's folder                        | `rewriteNoteRefsForMove`                  |
//! | a target open in a window: the window gets the blocks, the        | `feedExternalEditToCrdt` before the       |
//! | write-back keeps them                                             | write-back                                |
//! | a target whose document is ahead of its file is refused           | `note_edit_kept`, nothing written         |
//! | a locked or excluded target is refused                            | `note_locked`, `note_excluded`            |
//! | a missing note, nothing to move, the source itself                | `note_not_found`, `invalid_append`        |
//! | a write that fails refuses the move                               | the renderer keeps the source's blocks    |
//!
//! Every refusal leaves the source's file as it was: the renderer removes the blocks from the
//! source only after a move answers.

use std::sync::{Arc, Mutex};

use memry_core::domain::vault_locks::TargetKind;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::editor::{EditorHost, Subscriber};
use memry_desktop::error::CoreError;
use memry_desktop::notes::append_blocks::{AppendBlocksInput, AppendedBlocks};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::ChangeSource;
use memry_desktop::vault::hash::content_hash;

use crate::index_support::until;
use crate::notes_link_rewrite::{changes, id_at, row_hash};
use crate::vault_env::{Env, WAIT, env, indexed};
use crate::vault_exclude_read_only::exclude;

const SOURCE: &str = "Intro\n\nRelocate this line\n";
const TARGET: &str = "---\nkeep: 'as is'\n---\nFirst line\n\n\n";
const MOVED: &str = "Relocate this line\n";

type Frames = Arc<Mutex<Vec<Vec<u8>>>>;

struct Vault {
    e: Env,
    notes: Arc<NotesService>,
    store: Arc<dyn SecureStore>,
    host: Arc<EditorHost>,
}

/// A vault holding `files`, its notes served to windows by an editor host.
fn opened(files: &[(&str, &str)]) -> Vault {
    let kept = Mutex::new(None);
    let mut e = env(|store| {
        *kept.lock().unwrap() = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    let store: Arc<dyn SecureStore> = kept.into_inner().unwrap().expect("the store");
    let host = EditorHost::new(store.clone(), |_| {});
    host.register(&e.session);
    e.tier.set_editor_host(&host);
    for (rel, text) in files {
        e.write(rel, text);
    }
    e.open();
    e.facts_until(indexed);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    Vault {
        e,
        notes,
        store,
        host,
    }
}

impl Vault {
    fn append(
        &self,
        source: &str,
        target: &str,
        markdown: &str,
    ) -> Result<AppendedBlocks, NotesError> {
        let open = self.e.session.current().unwrap();
        let input = AppendBlocksInput {
            source_note_id: source.to_owned(),
            target_note_id: target.to_owned(),
            markdown: markdown.to_owned(),
        };
        self.notes.append_blocks(&open, input)
    }

    /// The frames a window showing `id` receives from now on.
    fn window(&self, id: &str, label: &str) -> Frames {
        let frames: Frames = Arc::default();
        let sink = Arc::clone(&frames);
        let subscriber = Subscriber {
            window_label: label.to_owned(),
            channel: Arc::new(move |frame| {
                sink.lock().unwrap().push(frame);
                true
            }),
        };
        self.host.open(id, Some(&self.e.vault), subscriber).unwrap();
        frames
    }

    /// The refusal's code, with the source and the target as they were.
    fn refused(&self, target_path: &str, target_text: &str, error: NotesError) -> &'static str {
        assert_eq!(
            self.e.read("Source.md"),
            SOURCE,
            "the source is never written"
        );
        assert_eq!(self.e.read(target_path), target_text, "{error:?}");
        error.kind_and_code().1
    }
}

fn holds(frames: &Frames, text: &str) -> bool {
    frames.lock().unwrap().iter().any(|frame| {
        frame
            .windows(text.len())
            .any(|bytes| bytes == text.as_bytes())
    })
}

#[test]
fn a_closed_target_takes_the_blocks_after_a_blank_line() {
    let mut v = opened(&[
        ("Source.md", SOURCE),
        ("Target.md", TARGET),
        ("Empty.md", "---\nkeep: 1\n---\n"),
    ]);
    let source = id_at(&v.e, "Source.md");
    let target = id_at(&v.e, "Target.md");
    v.e.drain();

    let appended = v.append(&source, &target, &format!("\n{MOVED}\n")).unwrap();

    assert_eq!(appended.target_path, "Target.md");
    let text = "---\nkeep: 'as is'\n---\nFirst line\n\nRelocate this line\n";
    assert_eq!(v.e.read("Target.md"), text);
    assert_eq!(
        v.e.read("Source.md"),
        SOURCE,
        "the renderer removes the block"
    );
    // The document holds the blocks and the row names the file, so the write-back has nothing
    // to write over them; no version is kept of a body nothing replaced.
    assert_eq!(v.e.body(&target), "First line\nRelocate this line");
    assert_eq!(row_hash(&v.e, &target), Some(content_hash(text)));
    assert!(v.e.versions(&target).is_empty());
    assert_eq!(
        changes(&mut v.e),
        [("Target.md".to_owned(), ChangeSource::AppEdit)]
    );

    // A body with nothing in it takes the blocks alone.
    let empty = id_at(&v.e, "Empty.md");
    v.append(&source, &empty, MOVED).unwrap();
    assert_eq!(
        v.e.read("Empty.md"),
        "---\nkeep: 1\n---\nRelocate this line\n"
    );
}

#[test]
fn refs_are_resolved_from_the_source_folder() {
    let v = opened(&[("a/Source.md", SOURCE), ("Target.md", "Top\n")]);
    let source = id_at(&v.e, "a/Source.md");
    let target = id_at(&v.e, "Target.md");

    v.append(&source, &target, "![photo](../attachments/p.png)\n")
        .unwrap();

    assert_eq!(
        v.e.read("Target.md"),
        "Top\n\n![photo](attachments/p.png)\n"
    );
}

#[test]
fn a_target_open_in_a_window_gets_the_blocks_and_the_write_back_keeps_them() {
    let v = opened(&[("Source.md", SOURCE), ("Target.md", TARGET)]);
    let source = id_at(&v.e, "Source.md");
    let target = id_at(&v.e, "Target.md");
    let frames = v.window(&target, "side");

    v.append(&source, &target, MOVED).unwrap();

    until("the window got the blocks", || {
        holds(&frames, "Relocate this line")
    });
    // A window edit the write-back writes out after the move carries the blocks with it.
    v.e.edit_in_app(&v.store, &target, "First line, edited");
    v.e.tier.schedule(&target);
    assert!(v.e.tier.flush(WAIT), "the write-back ran");
    assert_eq!(
        v.e.read("Target.md"),
        "---\nkeep: 'as is'\n---\nFirst line, edited\n\nRelocate this line\n"
    );
    assert_eq!(v.e.body(&target), "First line, edited\nRelocate this line");
}

#[test]
fn a_target_whose_document_is_ahead_of_its_file_is_refused() {
    let v = opened(&[("Source.md", SOURCE), ("Target.md", TARGET)]);
    let source = id_at(&v.e, "Source.md");
    let target = id_at(&v.e, "Target.md");
    // Typing stored in the document that the write-back has not written yet.
    v.e.edit_in_app(&v.store, &target, "Typed in the app");
    let body = v.e.body(&target);

    let error = v.append(&source, &target, MOVED).unwrap_err();

    assert_eq!(v.refused("Target.md", TARGET, error), "note_edit_kept");
    assert_eq!(v.e.body(&target), body);
    assert!(body.starts_with("Typed in the app"), "{body}");
}

#[test]
fn a_locked_or_excluded_target_is_refused() {
    let mut v = opened(&[
        ("Source.md", SOURCE),
        ("Target.md", TARGET),
        ("Locked/In.md", TARGET),
        ("archive/Old.md", TARGET),
    ]);
    let source = id_at(&v.e, "Source.md");
    let target = id_at(&v.e, "Target.md");
    let in_folder = id_at(&v.e, "Locked/In.md");
    let old = id_at(&v.e, "archive/Old.md");
    let locks = v.e.core().locks();
    locks.set(TargetKind::Note, &target, true).unwrap();
    locks.set(TargetKind::Folder, "Locked", true).unwrap();

    for (id, path) in [(&target, "Target.md"), (&in_folder, "Locked/In.md")] {
        let body = v.e.body(id);
        let error = v.append(&source, id, MOVED).unwrap_err();
        assert_eq!(v.refused(path, TARGET, error), "note_locked", "{path}");
        assert_eq!(v.e.body(id), body, "{path}");
    }

    exclude(&mut v.e, &["archive"]);
    let error = v.append(&source, &old, MOVED).unwrap_err();
    assert_eq!(v.refused("archive/Old.md", TARGET, error), "note_excluded");
}

#[test]
fn a_missing_note_nothing_to_move_or_the_source_itself_is_refused() {
    let v = opened(&[("Source.md", SOURCE), ("Target.md", TARGET)]);
    let source = id_at(&v.e, "Source.md");
    let target = id_at(&v.e, "Target.md");

    for (from, to, markdown, code) in [
        (source.as_str(), "missing", MOVED, "note_not_found"),
        ("missing", target.as_str(), MOVED, "note_not_found"),
        (source.as_str(), target.as_str(), " \n\t", "invalid_append"),
        (source.as_str(), source.as_str(), MOVED, "invalid_append"),
    ] {
        let error = v.append(from, to, markdown).unwrap_err();
        assert_eq!(
            v.refused("Target.md", TARGET, error),
            code,
            "{from} -> {to}"
        );
    }
}

/// A file the write cannot replace refuses the move: the renderer keeps the source's blocks.
#[cfg(unix)]
#[test]
fn a_write_that_fails_refuses_the_move() {
    use std::os::unix::fs::PermissionsExt;

    let v = opened(&[("Source.md", SOURCE), ("Shut/Target.md", TARGET)]);
    let source = id_at(&v.e, "Source.md");
    let target = id_at(&v.e, "Shut/Target.md");
    let folder = v.e.vault.join("Shut");
    let mode = |bits| std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(bits));
    mode(0o555).unwrap();

    let result = v.append(&source, &target, MOVED);

    mode(0o755).unwrap();
    let error = result.unwrap_err();
    assert_eq!(
        v.refused("Shut/Target.md", TARGET, error),
        "note_file_failed"
    );
}
