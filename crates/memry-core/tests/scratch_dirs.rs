//! A scratch directory is named by `tempfile`, never by `std::process::id()` (crates/AGENTS.md,
//! Conformance). Windows recycles process ids and a test that never removes its folder leaves its
//! `data.db` for the next run that draws the same id, which then re-inserts a fixed row id into it
//! (#4855: 9 of 11 `domain_inbox_attachments` tests failed on one collision).

use std::path::Path;

const PID: &str = concat!("process::", "id()");
const TEMP_DIR: &str = concat!("env::", "temp_dir()");

#[test]
fn no_test_names_its_scratch_directory_from_a_process_id() {
    let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut offenders = Vec::new();
    for entry in std::fs::read_dir(&tests).expect("list tests/") {
        let path = entry.expect("dir entry").path();
        if path.extension().is_none_or(|ext| ext != "rs") {
            continue;
        }
        let source = std::fs::read_to_string(&path).expect("read a test file");
        if source.contains(PID) && source.contains(TEMP_DIR) {
            offenders.push(path.file_name().expect("file name").to_owned());
        }
    }
    assert!(
        offenders.is_empty(),
        "build the scratch directory with `support::scratch_dir` (tempfile): {offenders:?}"
    );
}
