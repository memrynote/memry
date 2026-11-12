//! A locked note's write-back (Step 14e-2b): its document takes only another device's edits, so
//! the pass writes them through the lock, as Electron's `runWithLockedWritesAllowed(atomicWrite)`.

use memry_core::domain::vault_locks::TargetKind;

use super::{assert_wrote, fixture};
use crate::locks::Locks;

fn read_only(f: &super::Fixture, rel: &str) -> bool {
    std::fs::metadata(f.root.join(rel))
        .unwrap()
        .permissions()
        .readonly()
}

/// The read-only file takes the edit (Windows refuses to replace a read-only file, so the pass
/// clears the attribute first), is read-only again after, and its new text is the baseline an
/// outside edit is reverted to.
#[test]
fn another_devices_edit_of_a_locked_note_reaches_its_read_only_file_and_its_baseline() {
    let mut f = fixture();
    let id = f.adopt("Plan.md", "Locked text.\n");
    f.vault
        .locks()
        .set(TargetKind::Note, &id, true, "device-a")
        .unwrap();
    Locks::new(&f.root, &f.vault).reconcile().unwrap();
    assert!(read_only(&f, "Plan.md"));

    f.paragraph_from_sync(&id, "From the other device.");
    let outcome = f.run(&id);

    let written = assert_wrote(&mut f, &outcome, "Plan.md");
    assert!(written.contains("From the other device."), "{written}");
    assert!(read_only(&f, "Plan.md"));
    let baseline = f.vault.locks().baseline(&id).unwrap().expect("a baseline");
    assert_eq!(baseline.content, written);
}
