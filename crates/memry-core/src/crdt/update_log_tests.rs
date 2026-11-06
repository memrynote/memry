//! Tests of [`super`]: the two-namespace log against a real `data.db`.

use super::*;
use crate::storage::{Db, open_data, test_support::temp_dir};

fn db(label: &str) -> (crate::storage::test_support::TempDir, Db) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    (dir, db)
}

fn fold(conn: &mut Connection, doc_id: &str, snapshot: &[u8], at: i64) -> Result<i64, CrdtError> {
    let tx = conn.transaction().unwrap();
    let fold_at = fold_local_in(&tx, doc_id, snapshot, at)?;
    tx.commit().unwrap();
    Ok(fold_at)
}

#[test]
fn a_fold_outside_a_transaction_is_refused() {
    let (_dir, db) = db("update-log-fold-autocommit");
    db.call_blocking(|conn| {
        append_local_update(conn, "abc123def456", b"a", 1).unwrap();
        assert!(fold_local_in(conn, "abc123def456", b"s", 2).is_err());
        assert_eq!(
            load_plan(conn, "abc123def456").unwrap().local_updates.len(),
            1
        );
        Ok(())
    })
    .expect("autocommit");
}

#[test]
fn the_two_namespaces_are_different_rows() {
    assert_eq!(Namespace::Server.row_id("abc123def456"), "abc123def456");
    assert_eq!(
        Namespace::Local.row_id("abc123def456"),
        "local.abc123def456"
    );
    assert_eq!(Namespace::Local.row_id("j2026-04-16"), "local.j2026-04-16");
}

#[test]
fn a_local_append_never_collides_with_a_server_sequence() {
    let (_dir, db) = db("update-log-namespaces");
    db.call_blocking(|conn| {
        // The server numbered three updates for this document.
        for seq in 1..=3 {
            append_server_update(conn, "abc123def456", seq, &[seq as u8], 100).unwrap();
        }
        // A local append takes local sequence 1, not 4, and does not
        // overwrite the server's row 1.
        let first = append_local_update(conn, "abc123def456", b"local-1", 101).unwrap();
        let second = append_local_update(conn, "abc123def456", b"local-2", 102).unwrap();
        assert_eq!((first, second), (1, 2));

        let server = updates_after(conn, Namespace::Server, "abc123def456", 0).unwrap();
        let local = updates_after(conn, Namespace::Local, "abc123def456", 0).unwrap();
        assert_eq!(server.len(), 3);
        assert_eq!(server[0].update_blob, vec![1u8]);
        assert_eq!(local.len(), 2);
        assert_eq!(local[0].update_blob, b"local-1".to_vec());
        Ok(())
    })
    .expect("namespaces");
}

#[test]
fn a_duplicate_server_sequence_is_ignored_not_an_error() {
    let (_dir, db) = db("update-log-duplicate");
    db.call_blocking(|conn| {
        append_server_update(conn, "abc123def456", 7, b"first", 1).unwrap();
        append_server_update(conn, "abc123def456", 7, b"second", 2).unwrap();
        let rows = updates_after(conn, Namespace::Server, "abc123def456", 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].update_blob, b"first".to_vec());
        Ok(())
    })
    .expect("duplicate");
}

#[test]
fn a_fold_prunes_and_the_next_local_sequence_still_moves_forward() {
    let (_dir, db) = db("update-log-fold");
    db.call_blocking(|conn| {
        for n in 0..4 {
            append_local_update(conn, "abc123def456", &[n], 1).unwrap();
        }

        let fold_at = fold(conn, "abc123def456", b"snapshot-a", 10).unwrap();
        assert_eq!(fold_at, 4);
        assert!(
            updates_after(conn, Namespace::Local, "abc123def456", 0)
                .unwrap()
                .is_empty(),
            "the fold deletes the rows it absorbed"
        );

        // The count of surviving rows is zero; a fold that used a count as
        // a sequence would now hand out 1 again and overwrite history.
        let next = append_local_update(conn, "abc123def456", b"after", 11).unwrap();
        assert_eq!(next, 5);

        // A second fold with nothing new folds at the same point rather
        // than walking backwards.
        let second = fold(conn, "abc123def456", b"snapshot-b", 12).unwrap();
        assert_eq!(second, 5);

        let stored = snapshot(conn, Namespace::Local, "abc123def456")
            .unwrap()
            .expect("a local snapshot");
        assert_eq!(stored.snapshot, b"snapshot-b".to_vec());
        assert_eq!(stored.last_seq, 5);
        assert_eq!(
            stored.server_revision, None,
            "the local namespace never invents a revision"
        );
        Ok(())
    })
    .expect("fold");
}

#[test]
fn a_read_since_a_fold_point_consults_the_snapshot() {
    let (_dir, db) = db("update-log-plan");
    db.call_blocking(|conn| {
        put_server_snapshot(conn, "j2026-04-16", b"server-base", 12, Some("rev-1"), 5).unwrap();
        append_server_update(conn, "j2026-04-16", 11, b"already-folded", 6).unwrap();
        append_server_update(conn, "j2026-04-16", 13, b"after-fold", 7).unwrap();
        append_local_update(conn, "j2026-04-16", b"mine", 8).unwrap();

        let plan = load_plan(conn, "j2026-04-16").unwrap();

        assert_eq!(
            plan.server_snapshot.as_ref().map(|row| row.last_seq),
            Some(12)
        );
        assert_eq!(
            plan.server_snapshot
                .as_ref()
                .and_then(|row| row.server_revision.clone()),
            Some("rev-1".to_owned())
        );
        assert_eq!(plan.server_updates.len(), 1, "rows at or below the fold");
        assert_eq!(plan.server_updates[0].update_blob, b"after-fold".to_vec());
        assert_eq!(plan.local_updates.len(), 1);

        assert_eq!(
            plan.blobs(),
            vec![
                b"server-base".as_slice(),
                b"after-fold".as_slice(),
                b"mine".as_slice(),
            ],
            "server snapshot, server updates, local snapshot, local updates"
        );
        Ok(())
    })
    .expect("plan");
}

#[test]
fn a_purge_removes_both_namespaces_and_leaves_its_neighbour_alone() {
    let (_dir, db) = db("update-log-purge");
    db.call_blocking(|conn| {
        append_server_update(conn, "abc123def456", 1, b"a", 1).unwrap();
        append_local_update(conn, "abc123def456", b"b", 1).unwrap();
        put_server_snapshot(conn, "abc123def456", b"s", 1, None, 1).unwrap();
        fold(conn, "abc123def456", b"l", 1).unwrap();
        append_server_update(conn, "other12345678", 1, b"keep", 1).unwrap();

        purge(conn, "abc123def456").unwrap();

        assert!(load_plan(conn, "abc123def456").unwrap().is_empty());
        assert!(!load_plan(conn, "other12345678").unwrap().is_empty());
        Ok(())
    })
    .expect("purge");
}
