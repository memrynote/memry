//! A delete pulled while a pass writes this device's own body (#5809 review, low 2; #5823
//! review, low 2): the file holds bytes the document has, so the delete keeps no copy of them.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use memry_core::storage::repositories::sync_items;
use memry_core::sync::apply::apply_pulled_delete;
use memry_core::sync::clock::VectorClock;
use memry_core::sync::delete_keep::{OwnWrites, VaultFiles};
use memry_core::sync::outbox;

use super::*;

/// The delete lands after the pass's write and before its row stamp, which still names the
/// file it replaced. The note was a large file, so the pass records the class before the stamp
/// and waits there on the database writer the delete holds.
#[test]
fn a_delete_pulled_between_the_write_and_its_row_stamp_keeps_no_copy() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.edit_in_app(&id, "typed in the app");
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            let ids: Vec<i64> = conn
                .prepare("SELECT id FROM outbox")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            outbox::ack(conn, &ids).unwrap();
            Ok(())
        })
        .unwrap();
    f.sql(
        "INSERT OR IGNORE INTO note_large_files (note_id) VALUES (?1)",
        &id,
    );
    let own: Arc<dyn OwnWrites> = f.own_files.clone();
    let files = VaultFiles {
        root: f.root.clone(),
        own_writes: Some(own),
    };
    let (db, path, item) = (f.vault.db_handle(), f.root.join("n.md"), id.clone());
    let mut delete = Some(move || {
        let (started, waiting) = mpsc::channel();
        let deleting = std::thread::spawn(move || {
            db.call_blocking(move |conn| {
                started.send(()).unwrap();
                let deadline = Instant::now() + Duration::from_secs(10);
                let seen = loop {
                    let text = std::fs::read_to_string(&path).unwrap();
                    if text != "first words\n" {
                        break text;
                    }
                    assert!(Instant::now() < deadline, "the pass never wrote");
                    std::thread::sleep(Duration::from_millis(1));
                };
                let row = sync_items::load(conn, "note", &item)?.expect("the record");
                let mut clock: VectorClock =
                    serde_json::from_str(&row.clock.expect("a clock")).unwrap();
                let device = clock.keys().next().expect("this device's tick").clone();
                clock.insert("peer".into(), 1);
                let hour_later = now_ms() + 3_600_000;
                apply_pulled_delete(
                    conn, "note", &item, hour_later, &clock, hour_later, &device, files,
                )?;
                Ok(seen)
            })
            .unwrap()
        });
        waiting.recv().unwrap();
        deleting
    });
    let mut deleting = None;
    f.pass.run_checked(&id, &mut || {
        if let Some(delete) = delete.take() {
            deleting = Some(delete());
        }
    });
    let seen = deleting.expect("the pass wrote").join().unwrap();
    assert!(seen.contains("typed in the app"), "{seen}");

    let (kept, deleted) = f
        .vault
        .db_handle()
        .call_blocking(move |conn| {
            let kept: Vec<String> = conn
                .prepare("SELECT content FROM inbox_items")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let row = sync_items::load(conn, "note", &id)?.expect("the record");
            Ok((kept, row.deleted_at.is_some()))
        })
        .unwrap();
    assert_eq!(
        kept,
        Vec::<String>::new(),
        "no copy of the device's own body"
    );
    assert!(deleted, "the delete wins");
}
