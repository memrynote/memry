//! The manifest check's watermark (#5861, `sync::hardening::manifest_watermark`):
//! a check after a complete one lists only the rows written since, and lists
//! every row whenever the watermark cannot be trusted.
//!
//! Real `HttpClient`, SQLite and apply. The scripted transport panics on an
//! unscripted request, so a script without a `/sync/pull` proves no pull.

use crate::http_fakes::{FakeTransport, response};
use crate::sync_hardening_repairs::{envelope, now_ms, pull_live, pull_loop, queued, scratch_db};

use memry_core::api::errors::StorageError;
use memry_core::storage::Db;
use memry_core::sync::first_sync_store::read_meta;
use memry_core::sync::hardening::manifest::ManifestCheck;
use memry_core::sync::hardening::manifest_watermark::{
    FULL_INTERVAL_MS, META_MANIFEST_WATERMARK, Watermark,
};
use memry_core::sync::pull::PullLoop;
use serde_json::json;

const MINUTE_MS: i64 = 60_000;

/// One manifest page of `(type, id, serverCursor)`, the last one.
fn listed(items: &[(&str, &str, i64)]) -> String {
    let items: Vec<_> = items
        .iter()
        .map(|(item_type, id, cursor)| json!({"type": item_type, "id": id, "serverCursor": cursor}))
        .collect();
    json!({ "items": items }).to_string()
}

fn stored(db: &Db) -> Option<String> {
    db.call_blocking(|conn| read_meta(conn, META_MANIFEST_WATERMARK))
        .expect("read")
}

fn watermark(db: &Db) -> Watermark {
    serde_json::from_str(&stored(db).expect("a watermark")).expect("readable")
}

fn store(db: &Db, value: String) {
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [META_MANIFEST_WATERMARK, value.as_str()],
        )
        .map(drop)
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("seed the watermark");
}

/// A vault that pulled `t1` and `t2` live and ran one complete check, which
/// listed them at cursors 40 and 41 at `at`.
async fn checked_vault(at: i64) -> (Db, PullLoop) {
    let db = scratch_db();
    pull_live(&db, vec![envelope("t1", "task"), envelope("t2", "task")]).await;
    let transport = FakeTransport::new(vec![response(
        200,
        &listed(&[("task", "t1", 40), ("task", "t2", 41)]),
    )]);
    let pull = pull_loop(&db, transport.clone());
    ManifestCheck::default()
        .run(&pull, at)
        .await
        .expect("the full check")
        .expect("not throttled");
    assert_eq!(transport.calls_to("&cursor=0").len(), 1);
    (db, pull)
}

/// A fresh `ManifestCheck`, as an app reopen builds, over `script`.
async fn reopen_check(db: &Db, script: Vec<&str>, at: i64) -> std::sync::Arc<FakeTransport> {
    let transport = FakeTransport::new(script.into_iter().map(|b| response(200, b)).collect());
    ManifestCheck::default()
        .run(&pull_loop(db, transport.clone()), at)
        .await
        .expect("the check")
        .expect("not throttled");
    transport
}

#[tokio::test]
async fn a_reopen_with_no_server_change_reads_one_page_from_the_watermark() {
    let at = now_ms();
    let (db, _) = checked_vault(at).await;
    assert_eq!(watermark(&db).cursor, 41);
    assert_eq!(watermark(&db).full_at, at);

    let transport = reopen_check(&db, vec![&listed(&[])], at + MINUTE_MS).await;

    let urls: Vec<String> = transport.calls().into_iter().map(|c| c.url).collect();
    assert_eq!(urls.len(), 1, "{urls:?}");
    assert!(
        urls[0].ends_with("/sync/manifest?limit=1000&cursor=41"),
        "{urls:?}"
    );
    assert_eq!(
        watermark(&db).full_at,
        at,
        "a listing from the watermark keeps the full one's time"
    );
}

#[tokio::test]
async fn a_row_created_while_closed_is_pulled_and_the_watermark_moves_past_it() {
    let at = now_ms();
    let (db, _) = checked_vault(at).await;
    let pulled = json!({ "items": [envelope("t9", "task")] }).to_string();

    let transport = reopen_check(
        &db,
        vec![&listed(&[("task", "t9", 57), ("task", "t1", 50)]), &pulled],
        at + MINUTE_MS,
    )
    .await;

    assert_eq!(transport.calls_to("/sync/pull").len(), 1);
    assert_eq!(watermark(&db).cursor, 57);
    let live: bool = db
        .read_blocking(|conn| {
            conn.query_row(
                "SELECT deleted_at IS NULL FROM sync_items WHERE item_id = 't9'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("t9 is held");
    assert!(live);
}

#[tokio::test]
async fn a_listing_from_the_watermark_never_queues_a_local_row_it_does_not_name() {
    let at = now_ms();
    let (db, _) = checked_vault(at).await;

    reopen_check(&db, vec![&listed(&[])], at + MINUTE_MS).await;

    assert!(queued(&db).is_empty(), "t1 and t2 sit below the watermark");
}

/// Each stored value the check cannot trust lists every row.
#[tokio::test]
async fn an_untrusted_watermark_lists_every_row() {
    let at = now_ms();
    let base = |edit: &dyn Fn(&mut serde_json::Value)| {
        let mut value = json!({
            "v": 1, "vault": null,
            "types": crate::sync_hardening_repairs::declaration_header(),
            "cursor": 41, "fullAt": at,
        });
        edit(&mut value);
        value.to_string()
    };
    let cases: Vec<(&str, Option<String>)> = vec![
        ("missing", None),
        (
            "a crash left the check's token",
            Some(format!("pending:{at}:0")),
        ),
        ("unreadable", Some("{".to_owned())),
        ("a newer format", Some(base(&|v| v["v"] = json!(2)))),
        (
            "another vault",
            Some(base(&|v| v["vault"] = json!("vault-2"))),
        ),
        (
            "another declaration",
            Some(base(&|v| v["types"] = json!("note"))),
        ),
        (
            "a negative cursor",
            Some(base(&|v| v["cursor"] = json!(-1))),
        ),
        (
            "the full listing is a day old",
            Some(base(&|v| v["fullAt"] = json!(at - FULL_INTERVAL_MS))),
        ),
        (
            "written in the future",
            Some(base(&|v| v["fullAt"] = json!(at + 1))),
        ),
    ];
    for (case, value) in cases {
        let (db, _) = checked_vault(at - 2 * FULL_INTERVAL_MS).await;
        match value {
            Some(value) => store(&db, value),
            None => db
                .call_blocking(|conn| {
                    conn.execute("DELETE FROM meta WHERE key = ?1", [META_MANIFEST_WATERMARK])
                        .map(drop)
                        .map_err(|error| StorageError::Failed {
                            what: error.to_string(),
                        })
                })
                .expect("drop it"),
        }

        let transport = reopen_check(
            &db,
            vec![&listed(&[("task", "t1", 40), ("task", "t2", 41)])],
            at,
        )
        .await;

        assert_eq!(transport.calls_to("&cursor=0").len(), 1, "{case}");
        assert_eq!(
            watermark(&db).full_at,
            at,
            "{case}: a full listing founds a new one"
        );
    }
}

#[tokio::test]
async fn a_listing_from_the_watermark_that_names_an_older_row_or_stalls_is_redone_in_full() {
    let at = now_ms();
    let full = listed(&[("task", "t1", 40), ("task", "t2", 41)]);
    let older = listed(&[("task", "t1", 41)]);
    let uncursored = json!({"items": [{"type": "task", "id": "t1"}]}).to_string();
    let stalled = json!({"items": [], "nextCursor": 41}).to_string();
    for (case, first) in [
        ("older", older),
        ("no cursor", uncursored),
        ("stalled", stalled),
    ] {
        let (db, _) = checked_vault(at).await;

        let transport = reopen_check(&db, vec![&first, &full], at + MINUTE_MS).await;

        assert_eq!(transport.calls_to("&cursor=41").len(), 1, "{case}");
        assert_eq!(transport.calls_to("&cursor=0").len(), 1, "{case}");
        assert_eq!(watermark(&db).full_at, at + MINUTE_MS, "{case}");
    }
}

/// The rows a check pulls commit before its watermark: a check that fails in
/// between leaves its token, and the next one lists every row and pulls them.
#[tokio::test]
async fn a_check_that_fails_after_listing_a_row_never_skips_it() {
    let at = now_ms();
    let (db, _) = checked_vault(at).await;
    let transport = FakeTransport::new(vec![
        response(200, &listed(&[("task", "t9", 57)])),
        response(400, r#"{"error":{"code":"BAD","message":"no"}}"#),
    ]);
    let failed = ManifestCheck::default()
        .run(&pull_loop(&db, transport), at + MINUTE_MS)
        .await;
    assert!(failed.is_err(), "{failed:?}");
    assert!(stored(&db).expect("the token").starts_with("pending:"));

    let pulled = json!({ "items": [envelope("t9", "task")] }).to_string();
    let transport = reopen_check(
        &db,
        vec![
            &listed(&[("task", "t1", 40), ("task", "t2", 41), ("task", "t9", 57)]),
            &pulled,
        ],
        at + 2 * MINUTE_MS,
    )
    .await;

    assert_eq!(transport.calls_to("&cursor=0").len(), 1);
    assert_eq!(transport.calls_to("/sync/pull").len(), 1);
    assert_eq!(watermark(&db).cursor, 57);
}

#[tokio::test]
async fn a_row_leaving_the_outbox_or_sync_items_drops_the_watermark() {
    let at = now_ms();
    for sql in [
        "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('task', 't1', 'update', 1);
         DELETE FROM outbox;",
        "DELETE FROM sync_items WHERE item_id = 't2';",
    ] {
        let (db, _) = checked_vault(at).await;
        db.call_blocking(move |conn| {
            conn.execute_batch(sql).map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("the delete");
        assert_eq!(stored(&db), None, "{sql}");
    }
}

#[tokio::test]
async fn task_activity_pruning_keeps_the_watermark() {
    let at = now_ms();
    let (db, _) = checked_vault(at).await;
    db.call_blocking(|conn| {
        conn.execute_batch(
            "INSERT INTO sync_items (item_type, item_id, payload_state, updated_at)
               VALUES ('task_activity', 'a1', 'full', 1);
             DELETE FROM sync_items WHERE item_type = 'task_activity';",
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("prune");
    assert!(stored(&db).is_some());
}

#[tokio::test]
async fn a_check_that_left_a_listed_row_refused_founds_no_watermark() {
    let db = scratch_db();
    db.call_blocking(|conn| {
        conn.execute_batch(
            "INSERT INTO sync_refused_items (item_type, item_id, refused_by_version, refused_at)
             VALUES ('task', 't5', 'this-build', 0);",
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("seed");

    reopen_check(&db, vec![&listed(&[("task", "t5", 9)])], now_ms()).await;

    assert!(stored(&db).expect("the token").starts_with("pending:"));
}

#[tokio::test]
async fn a_check_that_must_ask_about_a_note_founds_no_watermark() {
    let db = scratch_db();
    pull_live(&db, vec![envelope("n1", "note")]).await;
    let held = json!({ "items": [envelope("n1", "note")] }).to_string();

    reopen_check(&db, vec![&listed(&[]), &held], now_ms()).await;

    assert!(queued(&db).is_empty());
    assert!(stored(&db).expect("the token").starts_with("pending:"));
}

/// A check from the watermark lists `t9` at 57 and `/sync/pull` answers
/// `answer`, which leaves `t9` unheld: the watermark stays before `t9`, and the
/// next check lists every row and pulls `t9` again.
async fn an_unheld_pull_keeps_the_row_listed(answer: &str) {
    let at = now_ms();
    let (db, _) = checked_vault(at).await;
    reopen_check(
        &db,
        vec![&listed(&[("task", "t9", 57)]), answer],
        at + MINUTE_MS,
    )
    .await;
    assert!(
        stored(&db).expect("the token").starts_with("pending:"),
        "{answer}"
    );

    let pulled = json!({ "items": [envelope("t9", "task")] }).to_string();
    let transport = reopen_check(
        &db,
        vec![
            &listed(&[("task", "t1", 40), ("task", "t2", 41), ("task", "t9", 57)]),
            &pulled,
        ],
        at + 2 * MINUTE_MS,
    )
    .await;

    assert_eq!(transport.calls_to("&cursor=0").len(), 1, "{answer}");
    assert_eq!(transport.calls_to("/sync/pull").len(), 1, "{answer}");
    assert_eq!(watermark(&db).cursor, 57);
}

#[tokio::test]
async fn a_pull_that_serves_nothing_never_moves_the_watermark_past_the_row() {
    an_unheld_pull_keeps_the_row_listed(r#"{"items":[]}"#).await;
}

#[tokio::test]
async fn a_pull_that_serves_an_unreadable_entry_never_moves_the_watermark_past_the_row() {
    an_unheld_pull_keeps_the_row_listed(r#"{"items":[{"id":"t9"}]}"#).await;
}

/// Through the desktop driver: a reopen reads the record feed from its
/// cursor, which applies a create, a change and a delete made while the app
/// was closed, and lists the manifest from the watermark in one request.
#[cfg(feature = "markdown")]
#[tokio::test]
async fn a_reopen_applies_what_changed_while_closed_and_reads_one_manifest_page() {
    use crate::driver_fakes::Desktop;
    use memry_core::protocol::types::Declaration;

    const TYPES: [&str; 2] = ["task", "project"];
    let desktop = Desktop::open(&TYPES, |_| Ok(())).await;
    desktop
        .server
        .put("task", "t1", json!({"title": "one", "clock": {"peer": 1}}));
    desktop
        .server
        .put("task", "t2", json!({"title": "two", "clock": {"peer": 1}}));
    desktop.server.page(&["t1", "t2"], "10");
    desktop.pass().await;
    assert_eq!(desktop.server.count("/sync/manifest"), 1);

    desktop.server.put(
        "task",
        "t3",
        json!({"title": "three", "clock": {"peer": 1}}),
    );
    desktop.server.put(
        "task",
        "t1",
        json!({"title": "one, edited", "clock": {"peer": 2}}),
    );
    desktop.server.delete("task", "t2");
    desktop.server.page(&["t3", "t1", "t2"], "11");
    let desktop = desktop
        .reopen(Declaration::declare(&TYPES).expect("recognised"))
        .await;
    desktop.pass().await;

    let manifests: Vec<String> = desktop
        .server
        .urls()
        .into_iter()
        .filter(|url| url.contains("/sync/manifest"))
        .collect();
    assert_eq!(manifests.len(), 2, "{manifests:?}");
    assert!(manifests[1].ends_with("cursor=2"), "{manifests:?}");
    let rows: Vec<(String, bool, String)> = desktop
        .db
        .read_blocking(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT item_id, deleted_at IS NULL, COALESCE(payload, '') FROM sync_items
                      WHERE item_type = 'task' ORDER BY item_id",
                )
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .and_then(Iterator::collect)
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("the rows");
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert!(rows[0].1 && rows[0].2.contains("one, edited"), "{rows:?}");
    assert!(!rows[1].1, "t2 deleted: {rows:?}");
    assert!(rows[2].1 && rows[2].2.contains("three"), "{rows:?}");
}
