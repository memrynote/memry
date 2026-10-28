//! A body that changed reaches the file, whoever changed it, with every byte nobody edited
//! kept and the replaced file kept as a version.

use super::*;

#[test]
fn an_edit_made_in_the_app_reaches_the_file() {
    let mut f = fixture();
    let id = f.adopt("n.md", "---\ntitle: Kept\n---\nfirst words\n");
    f.edit_in_app(&id, "typed in the app");
    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, "n.md");
    assert_eq!(file, "---\ntitle: Kept\n---\ntyped in the app\n");
}

#[test]
fn a_body_merged_from_sync_reaches_the_file() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.paragraph_from_sync(&id, "from the other device");
    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, "n.md");
    assert!(
        file.contains("first words") && file.contains("from the other device"),
        "{file}"
    );
}

/// No byte change, no write: the mtime stays, and no fact or version comes of it.
#[test]
fn a_body_the_file_already_says_is_no_write() {
    let mut f = fixture();
    let text = "---\ntitle: Same\n---\nsame words\n";
    let id = f.adopt("n.md", text);
    let path = f.root.join("n.md");
    let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("n.md"), text);
    assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), old);
    assert!(f.facts().is_empty());
    assert!(f.versions(&id).is_empty());
}

/// A file with a byte order mark and CRLF line ends, edited in the app and by sync: the mark,
/// the frontmatter block and every line end stay as the author's editor wrote them.
#[test]
fn a_write_keeps_the_byte_order_mark_the_line_ends_and_the_frontmatter_block() {
    for (text, block) in [
        (
            "\u{feff}---\r\ntitle:   'spaced'\r\n---\r\nfirst words\r\n",
            Some("\u{feff}---\r\ntitle:   'spaced'\r\n---\r\n"),
        ),
        ("\u{feff}first words\r\n", None),
    ] {
        let mut f = fixture();
        let id = f.adopt("n.md", text);
        f.edit_in_app(&id, "typed in the app");
        let outcome = f.run(&id);
        let file = assert_wrote(&mut f, &outcome, "n.md");
        f.paragraph_from_sync(&id, "from the other device");
        let outcome = f.run(&id);
        let file2 = assert_wrote(&mut f, &outcome, "n.md");
        for file in [&file, &file2] {
            assert!(file.starts_with('\u{feff}'), "{file:?}");
            assert!(
                !file.replace("\r\n", "").contains('\n'),
                "a bare LF: {file:?}"
            );
            if let Some(block) = block {
                assert!(file.starts_with(block), "{file:?}");
            }
        }
        assert!(file.contains("typed in the app\r\n"), "{file:?}");
        assert!(file2.contains("from the other device"), "{file2:?}");
    }
}

/// The file a write replaces is kept when the app did not write it in this session; its own
/// last write is not kept again.
#[test]
fn a_replaced_file_the_app_did_not_write_is_kept_as_a_version() {
    let mut f = fixture();
    let text = "---\ntitle: Kept\n---\nwritten outside the app\n";
    let id = f.adopt("n.md", text);
    f.edit_in_app(&id, "typed in the app");
    let first = f.run(&id);
    assert!(
        matches!(
            first,
            Outcome::Wrote {
                version_kept: true,
                ..
            }
        ),
        "{first:?}"
    );
    assert_eq!(f.versions(&id), vec![text.to_owned()]);
    let written = assert_wrote(&mut f, &first, "n.md");

    f.paragraph_from_sync(&id, "from the other device");
    let second = f.run(&id);
    assert!(
        matches!(
            second,
            Outcome::Wrote {
                version_kept: false,
                ..
            }
        ),
        "{second:?}"
    );
    assert_eq!(f.versions(&id), vec![text.to_owned()], "{written}");
}

/// A `writing:` key that is the author's own is their property: it stays, and the row says
/// the document holds the file.
#[test]
fn an_authors_own_writing_key_stays_through_a_write() {
    let mut f = fixture();
    let id = f.adopt("n.md", "---\nwriting: draft two\n---\nfirst words\n");
    f.edit_in_app(&id, "typed in the app");
    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, "n.md");
    assert_eq!(file, "---\nwriting: draft two\n---\ntyped in the app\n");
}

/// The writing tools data the document holds goes back to the file with the body. A version
/// spelled `- text: two` is written `- two`, as desktop writes it (`toWritingFrontmatterValue`):
/// a frontmatter-only change, which keeps no version.
#[test]
fn the_writing_data_the_document_holds_is_written_with_the_body() {
    let mut f = fixture();
    let text = "---\nwriting:\n  alternatives:\n    k3x9q2:\n      versions:\n        - text: two\n        - text: zwei\n---\none <!--alt:k3x9q2-->two<!--/alt:k3x9q2--> three\n";
    let id = f.adopt("n.md", text);
    let first = f.run(&id);
    assert!(
        matches!(
            first,
            Outcome::Wrote {
                version_kept: false,
                ..
            }
        ),
        "{first:?}"
    );
    let short = text.replace("- text: ", "- ");
    assert_eq!(assert_wrote(&mut f, &first, "n.md"), short);
    assert_eq!(f.run(&id), Outcome::Unchanged);
    f.paragraph_from_sync(&id, "from the other device");
    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, "n.md");
    assert!(
        file.starts_with("---\nwriting:\n  alternatives:\n    k3x9q2:"),
        "{file}"
    );
    assert!(
        file.contains("<!--alt:k3x9q2-->two<!--/alt:k3x9q2-->"),
        "{file}"
    );
    assert!(file.contains("from the other device"), "{file}");
}

/// The seam Steps 14 and 17 call: a scheduled note is written on the write-back thread.
#[test]
fn a_scheduled_note_is_written_on_the_write_back_thread() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.edit_in_app(&id, "typed in the app");
    let pass = std::mem::replace(
        &mut f.pass,
        Pass::new(
            f.root.clone(),
            f.vault.clone(),
            f.rows.clone(),
            f.rows.session_for(&f.vault).unwrap(),
            f.echo.clone(),
            None,
        ),
    );
    let mut writeback = super::super::WriteBack::start(pass).unwrap();
    writeback.schedule(&id);
    writeback.schedule(&id);
    writeback.stop();
    assert_eq!(f.read("n.md"), "typed in the app\n");
    let changed = f
        .facts()
        .into_iter()
        .filter(|fact| matches!(fact, Applied::Changed { .. }))
        .count();
    assert!(changed >= 1);
}
