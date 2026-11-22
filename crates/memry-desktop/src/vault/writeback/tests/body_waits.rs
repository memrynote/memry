//! A note whose pass found its server body not pulled gets its file once the sync's body step
//! settles (`WriteBack::schedule_body_waits`, #5410), with the real pass. The pass's own rules
//! still keep a file the user made or edited meanwhile.

use std::time::Duration;

use memry_core::crdt::body_edit::BlockEdit;

use super::schedule::real;
use super::{Fixture, fixture};

const WAIT: Duration = Duration::from_secs(10);

/// The consumer's open walk ended: every file on disk has a row.
fn walked(f: &Fixture) {
    f.rows.lane_of(f.pass.session).unwrap().set_walked(true);
}

/// The rest of the server body arrived: the pull settled the note's debt.
fn settle(f: &Fixture, id: &str) {
    f.sql("DELETE FROM meta WHERE key = 'sync.body_owed:' || ?1", id);
}

/// Red while a note kept for its unpulled body was never scheduled again: on a fresh device its
/// body settled with no tell of its own and the vault never got its file.
#[test]
fn a_note_kept_for_its_body_gets_its_file_once_the_bodies_settle() {
    let mut f = fixture();
    let edited = f.adopt("Edited.md", "first words\n");
    let plan = f.writer.create("Plan".into(), None).unwrap();
    let draft = f.writer.create("Draft".into(), None).unwrap();
    f.edit_in_app(&edited, "pulled e");
    for (id, text) in [(&plan, "pulled p"), (&draft, "pulled d")] {
        let typed = BlockEdit::InsertParagraph {
            after_block_id: None,
            text: text.into(),
            new_block_id: format!("{id}-p"),
        };
        assert!(f.writer.edit_block(id.clone(), typed).unwrap());
    }
    for id in [&edited, &plan, &draft] {
        f.owe_server_body(id);
    }
    walked(&f);
    let (writeback, _told) = real(&mut f);
    for id in [&edited, &plan, &draft] {
        writeback.schedule(id);
    }
    assert!(writeback.flush(WAIT));
    assert!(
        !f.root.join("Plan.md").exists(),
        "no file while the body is owed"
    );
    assert!(!f.root.join("Draft.md").exists());
    assert_eq!(f.read("Edited.md"), "first words\n");

    for id in [&edited, &plan, &draft] {
        settle(&f, id);
    }
    // Meanwhile the user edited one file and made one at the draft's name: both are theirs.
    f.write("Edited.md", "edited outside\n");
    f.write("Draft.md", "the user's own words\n");
    writeback.schedule_body_waits(|waits| f.vault.note_files().server_bodies_owed(waits).unwrap());
    assert!(writeback.flush(WAIT));
    writeback.stop();

    assert!(
        f.read("Plan.md").contains("pulled p"),
        "{:?}",
        f.read("Plan.md")
    );
    assert_eq!(f.read("Edited.md"), "edited outside\n");
    assert_eq!(f.read("Draft.md"), "the user's own words\n");
}
