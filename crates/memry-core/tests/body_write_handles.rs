//! #5734: body writes through several `Db` handles on one `data.db`.
//!
//! Every handle authors under the device's one Yjs client id. Two handles
//! that each read the log and then append to it could both mint the clock
//! after the newest row, and a log holding one `(client, clock)` twice no
//! longer replays: the note body is lost. A second connection is what a
//! second process opening the vault has, so the threads here stand in for
//! one.

use std::path::Path;
use std::sync::{Arc, Barrier};
use std::thread;

use memry_core::crdt::update_log;
use memry_core::domain::{body_write, notes, reads};
use memry_core::storage::open_data;

const NOTE: &str = "note5734abcd";
const DEVICE: &str = "device-a";
const WRITERS: usize = 4;
const APPENDS: usize = 25;

fn create_note(path: &Path) {
    let db = open_data(path).expect("open data.db");
    db.call_blocking(|conn| {
        notes::create(
            conn,
            &notes::NewNote {
                id: NOTE,
                title: "Shared",
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
                emoji: None,
            },
            DEVICE,
            1,
        )
        .map(|_| ())
    })
    .expect("create the note");
}

#[test]
fn concurrent_handles_on_one_database_keep_the_body_replayable() {
    let dir = std::env::temp_dir().join(format!("memry-5734-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("data.db");
    create_note(&path);

    let start = Arc::new(Barrier::new(WRITERS));
    let writers: Vec<_> = (0..WRITERS)
        .map(|writer| {
            let path = path.clone();
            let start = Arc::clone(&start);
            thread::spawn(move || {
                let db = open_data(&path).expect("open a second handle");
                start.wait();
                for append in 0..APPENDS {
                    let markdown = format!("writer {writer} line {append}");
                    db.call_blocking(|conn| {
                        body_write::append_markdown(conn, NOTE, &markdown, DEVICE, 2).map_err(
                            |error| memry_core::api::errors::StorageError::Failed {
                                what: error.to_string(),
                            },
                        )
                    })
                    .expect("append");
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().expect("a writer panicked");
    }

    let db = open_data(&path).expect("reopen");
    let (blocks, rows) = db
        .call_blocking(|conn| {
            let blocks = reads::note_blocks(conn, NOTE).map_err(|error| {
                memry_core::api::errors::StorageError::Failed {
                    what: format!("the body no longer replays: {error}"),
                }
            })?;
            let rows = update_log::load_plan(conn, NOTE)
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })?
                .blobs()
                .len();
            Ok((blocks, rows))
        })
        .expect("read the body");
    let text = format!("{:?}", blocks.expect("the note has a body"));
    assert_eq!(rows, WRITERS * APPENDS, "one log row per append");
    for writer in 0..WRITERS {
        for append in 0..APPENDS {
            let line = format!("writer {writer} line {append}");
            assert!(text.contains(&line), "{line} is missing from the body");
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}
