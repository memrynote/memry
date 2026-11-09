//! An attachment rename a body carries moves the file on this device (#1714, #3531 14f-3b):
//! the pass's call to `attachments::reconcile_renames` after it wrote the note's file, on real
//! files, and the guards of the move. Electron's `attachment-rename-reconcile.test.ts` cases are
//! here too.
//!
//! | Test                                                               | Guard                        |
//! | ------------------------------------------------------------------ | ---------------------------- |
//! | a renamed ref moves the file once, a note's and a journal day's    | the call in the pass         |
//! | a locked note's file keeps its name                                | `writable_in`                |
//! | an outside edit wins and moves nothing                             | only after a write           |
//! | a taken name, a gone file, an ambiguous prefix move nothing        | `rename_no_replace`, plan    |
//! | a name that climbs out of the folder moves nothing                 | `is_stored_name`             |
//! | another extension or a hidden character moves nothing             | plan, `is_stored_name`       |
//! | a link at the file or the folder is never moved through            | file type, `plain_folder`    |

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use memry_core::crdt::BODY_FRAGMENT;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::domain::vault_locks::TargetKind;

use super::{Fixture, Keep, Outcome, assert_wrote, fixture};
use crate::attachments::{PlannedRename, plan_renames, reconcile_renames};

fn folder(f: &Fixture, id: &str) -> PathBuf {
    f.root.join("attachments").join(id)
}

fn attach(f: &Fixture, id: &str, name: &str, bytes: &str) {
    fs::create_dir_all(folder(f, id)).unwrap();
    fs::write(folder(f, id).join(name), bytes).unwrap();
}

fn names(f: &Fixture, id: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(folder(f, id))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// A note at `rel` embedding `attachments/<id>/k3f9x2-old.png`, which holds `old bytes`.
fn note_with_image(f: &mut Fixture, rel: &str) -> String {
    let id = f.writer.create("Note".into(), None).unwrap();
    let text = format!("Intro\n\n![shot](attachments/{id}/k3f9x2-old.png)\n");
    f.seed(&id, rel, &text);
    attach(f, &id, "k3f9x2-old.png", "old bytes");
    id
}

/// The block's `url` set to `attachments/<id>/<name>`: what a rename on another device sends.
fn point_image_at(f: &Fixture, id: &str, name: &str) {
    let blocks = f.vault.notes().blocks(id.to_owned()).unwrap().unwrap();
    let block_id = blocks
        .iter()
        .find(|block| block.kind == "image")
        .and_then(|block| block.id.clone())
        .expect("the image block");
    let edit = BlockEdit::SetProp {
        block_id,
        name: "url".into(),
        value: format!("attachments/{id}/{name}"),
    };
    assert!(f.writer.edit_block(id.to_owned(), edit).unwrap());
}

#[test]
fn a_renamed_ref_moves_the_file_once() {
    let mut f = fixture();
    let id = note_with_image(&mut f, "n.md");
    point_image_at(&f, &id, "k3f9x2-invoice.png");
    let outcome = f.run(&id);
    let written = assert_wrote(&mut f, &outcome, "n.md");
    assert!(written.contains("k3f9x2-invoice.png"), "{written}");
    assert_eq!(names(&f, &id), ["k3f9x2-invoice.png"]);
    let moved = folder(&f, &id).join("k3f9x2-invoice.png");
    assert_eq!(fs::read_to_string(moved).unwrap(), "old bytes");
    // Run again: the file has the name already, so nothing moves.
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(names(&f, &id), ["k3f9x2-invoice.png"]);
}

#[test]
fn a_journal_days_renamed_ref_moves_its_file() {
    let mut f = fixture();
    // A day's id is `j<date>`.
    let text = "Day\n\n![shot](attachments/j2026-01-02/k3f9x2-old.png)\n";
    let id = f.adopt_day("journal/2026-01-02.md", "2026-01-02", text);
    assert_eq!(id, "j2026-01-02");
    attach(&f, &id, "k3f9x2-old.png", "old bytes");
    // Another device's rename, merged from sync.
    let url = format!("attachments/{id}/k3f9x2-new.png");
    f.edit_from_sync(&id, move |txn| {
        use yrs::{Xml as _, XmlFragment as _, XmlOut};
        let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
        let Some(XmlOut::Element(group)) = fragment.get(txn, 0) else {
            panic!("a seeded body starts with its block group");
        };
        for at in 0..group.len(txn) {
            if let Some(XmlOut::Element(container)) = group.get(txn, at)
                && let Some(XmlOut::Element(block)) = container.get(txn, 0)
                && block.tag().as_ref() == "image"
            {
                block.insert_attribute(txn, "url", url.clone());
            }
        }
    });
    let outcome = f.run(&id);
    let written = assert_wrote(&mut f, &outcome, "journal/2026-01-02.md");
    assert!(written.contains("k3f9x2-new.png"), "{written}");
    assert_eq!(names(&f, &id), ["k3f9x2-new.png"]);
}

#[test]
fn a_locked_notes_file_keeps_its_name() {
    for (kind, folder_lock) in [(TargetKind::Note, false), (TargetKind::Folder, true)] {
        let mut f = fixture();
        let id = note_with_image(&mut f, "work/n.md");
        point_image_at(&f, &id, "k3f9x2-invoice.png");
        let target = if folder_lock { "work" } else { id.as_str() };
        f.vault.locks().set(kind, target, true).unwrap();
        // The write-back takes the body through the lock; the file is left to self-heal.
        let outcome = f.run(&id);
        let written = assert_wrote(&mut f, &outcome, "work/n.md");
        assert!(written.contains("k3f9x2-invoice.png"), "{written}");
        assert_eq!(names(&f, &id), ["k3f9x2-old.png"], "{target}");
    }
}

#[test]
fn an_outside_edit_wins_and_moves_nothing() {
    let mut f = fixture();
    let id = note_with_image(&mut f, "n.md");
    point_image_at(&f, &id, "k3f9x2-invoice.png");
    let outside = format!("Edited outside\n\n![shot](attachments/{id}/k3f9x2-old.png)\n");
    f.write("n.md", &outside);
    let outcome = f.run(&id);
    super::assert_kept(&mut f, &outcome, Keep::FileChanged, "n.md", &outside);
    assert_eq!(names(&f, &id), ["k3f9x2-old.png"]);
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

fn plan(from: &str, to: &str) -> PlannedRename {
    PlannedRename {
        from: from.into(),
        to: to.into(),
    }
}

#[test]
fn plans_follow_electrons_cases() {
    let cases: [(&[&str], &[&str], Vec<PlannedRename>); 6] = [
        (
            &["k3f9x2-scan.pdf"],
            &["k3f9x2-invoice.pdf"],
            vec![plan("k3f9x2-scan.pdf", "k3f9x2-invoice.pdf")],
        ),
        (
            &["aaaaaa-one.pdf", "bbbbbb-two.pdf"],
            &["aaaaaa-first.pdf", "bbbbbb-second.pdf"],
            vec![
                plan("aaaaaa-one.pdf", "aaaaaa-first.pdf"),
                plan("bbbbbb-two.pdf", "bbbbbb-second.pdf"),
            ],
        ),
        (&["k3f9x2-scan.pdf"], &[], vec![]),
        (&[], &["k3f9x2-scan.pdf"], vec![]),
        (
            &["k3f9x2-scan.pdf"],
            &["k3f9x2-a.pdf", "k3f9x2-b.pdf"],
            vec![],
        ),
        (&["scan.pdf"], &["invoice.pdf"], vec![]),
    ];
    for (previous, next, expected) in cases {
        assert_eq!(
            plan_renames(&set(previous), &set(next)),
            expected,
            "{previous:?}"
        );
    }
    // Not a rename the app makes: another extension, a hidden or a refused character.
    for to in [
        "k3f9x2-a.html",
        "k3f9x2-\u{202e}a.png",
        "k3f9x2-a?.png",
        "k3f9x2-a\u{1}.png",
    ] {
        assert_eq!(
            plan_renames(&set(&["k3f9x2-a.png"]), &set(&[to])),
            [],
            "{to:?}"
        );
    }
}

/// Renames between bodies naming `previous` and `next` in the note's folder.
fn reconcile(f: &Fixture, id: &str, previous: &str, next: &str) -> Vec<PlannedRename> {
    let body = |name: &str| format!("![x](../attachments/{id}/{name})\n");
    reconcile_renames(&f.root, &f.vault, id, &body(previous), &body(next))
}

#[test]
fn a_taken_name_a_gone_file_or_an_ambiguous_prefix_moves_nothing() {
    let f = fixture();
    let id = "n1";
    attach(&f, id, "k3f9x2-scan.pdf", "scan");
    attach(&f, id, "k3f9x2-invoice.pdf", "other");
    assert_eq!(
        reconcile(&f, id, "k3f9x2-scan.pdf", "k3f9x2-invoice.pdf"),
        []
    );
    assert_eq!(names(&f, id), ["k3f9x2-invoice.pdf", "k3f9x2-scan.pdf"]);
    let kept = fs::read_to_string(folder(&f, id).join("k3f9x2-invoice.pdf")).unwrap();
    assert_eq!(kept, "other");
    // This device made the rename: the old name is gone.
    assert_eq!(reconcile(&f, id, "aaaaaa-gone.pdf", "aaaaaa-here.pdf"), []);
    // Two arrivals with one prefix.
    let both =
        format!("![a](../attachments/{id}/k3f9x2-a.pdf) ![b](../attachments/{id}/k3f9x2-b.pdf)\n");
    let previous = format!("![s](../attachments/{id}/k3f9x2-scan.pdf)\n");
    assert_eq!(
        reconcile_renames(&f.root, &f.vault, id, &previous, &both),
        []
    );
    assert_eq!(names(&f, id), ["k3f9x2-invoice.pdf", "k3f9x2-scan.pdf"]);
    // An id that is not one folder name.
    assert_eq!(
        reconcile_renames(&f.root, &f.vault, "../x", &previous, &both),
        []
    );
}

#[test]
fn a_name_that_climbs_out_of_the_folder_moves_nothing() {
    let f = fixture();
    let id = "n1";
    f.write("n.md", "the note\n");
    attach(&f, id, "k3f9x2-a.png", "bytes");
    fs::create_dir_all(folder(&f, id).join("k3f9x2-d")).unwrap();
    fs::create_dir_all(folder(&f, id).join("k3f9x2-z")).unwrap();
    // Out: the attachment to the vault's parent. In: the note's file into the folder.
    let out = reconcile(&f, id, "k3f9x2-a.png", "k3f9x2-d/../../../../moved.png");
    let into = reconcile(&f, id, "k3f9x2-z/../../../n.md", "k3f9x2-z.md");
    assert_eq!((out, into), (vec![], vec![]));
    assert!(folder(&f, id).join("k3f9x2-a.png").is_file());
    assert_eq!(f.read("n.md"), "the note\n");
    assert!(!f.root.parent().unwrap().join("moved.png").exists());
}

#[cfg(unix)]
#[test]
fn a_link_at_the_file_or_the_folder_is_never_moved_through() {
    use std::os::unix::fs::symlink;
    let f = fixture();
    let id = "n1";
    f.write("n.md", "the note\n");
    fs::create_dir_all(folder(&f, id)).unwrap();
    symlink(f.root.join("n.md"), folder(&f, id).join("k3f9x2-l.md")).unwrap();
    assert_eq!(reconcile(&f, id, "k3f9x2-l.md", "k3f9x2-m.md"), []);
    assert_eq!(names(&f, id), ["k3f9x2-l.md"]);
    // The note's folder is a link to another folder of the vault.
    let real = f.root.join("elsewhere");
    fs::rename(folder(&f, id), &real).unwrap();
    fs::write(real.join("k3f9x2-a.png"), "bytes").unwrap();
    symlink(&real, folder(&f, id)).unwrap();
    assert_eq!(reconcile(&f, id, "k3f9x2-a.png", "k3f9x2-b.png"), []);
    assert!(real.join("k3f9x2-a.png").is_file() && !real.join("k3f9x2-b.png").exists());
}
