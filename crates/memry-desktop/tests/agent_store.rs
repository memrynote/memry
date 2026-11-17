//! The agent store over a real `Vault` and `data.db` (Step 28, #3545): sealed at rest, kept in
//! memory without a readable key and on disk again once the keychain answers, streaming rows that
//! survive a reopen and never sync, and the entitlement gate with its backfill.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use memry_core::api::errors::SecureStoreError;
use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::agent::store::gate::{EntitlementGate, run_backfill};
use memry_desktop::agent::store::{
    AgentStore, MessageEdit, NewConversation, NewMessage, StoreParts,
};
use memry_desktop::session::at_rest_key::AtRestKeys;
use rusqlite::Connection;
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};

use crate::device_key;

/// The device keychain, answering `Locked` while `locked` is set.
struct Keychain {
    inner: Arc<dyn SecureStore>,
    locked: AtomicBool,
}

impl SecureStore for Keychain {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if self.locked.load(Ordering::SeqCst) {
            return Err(SecureStoreError::Locked);
        }
        self.inner.get(key)
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.inner.set(key, value)
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.inner.delete(key)
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.inner.clear()
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    keychain: Arc<Keychain>,
    keys: Arc<AtRestKeys>,
    paid: watch::Sender<bool>,
    recovered: broadcast::Sender<()>,
}

impl Fixture {
    fn new(paid: bool) -> Self {
        let inner = device_key::with_device_key();
        inner.set(SecureStoreKey::MasterKey, vec![9u8; 32]).unwrap();
        let keychain = Arc::new(Keychain {
            inner,
            locked: AtomicBool::new(false),
        });
        Self {
            dir: tempfile::tempdir().unwrap(),
            keys: AtRestKeys::new(keychain.clone()),
            keychain,
            paid: watch::Sender::new(paid),
            recovered: broadcast::Sender::new(4),
        }
    }

    fn core(&self) -> std::path::PathBuf {
        let core = self.dir.path().join("vault").join(".memry").join("core");
        std::fs::create_dir_all(&core).unwrap();
        core
    }

    fn vault(&self) -> Arc<Vault> {
        Arc::new(Vault::open("v1".into(), self.core().to_string_lossy().into_owned()).unwrap())
    }

    fn store(&self, vault: &Arc<Vault>) -> Arc<AgentStore> {
        AgentStore::open(
            StoreParts {
                vault: Arc::clone(vault),
                keys: Arc::clone(&self.keys),
                device_id: "device-a".to_owned(),
                gate: EntitlementGate::new(self.paid.subscribe()),
                keychain_recovered: self.recovered.subscribe(),
            },
            &tokio::runtime::Handle::current(),
        )
    }

    /// A plain read of `data.db`, as anyone with the file can do.
    fn plain(&self) -> Connection {
        Connection::open(self.core().join("data.db")).unwrap()
    }
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// Every value of `table` as text.
fn cells(conn: &Connection, table: &str) -> Vec<String> {
    let mut statement = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
    let width = statement.column_count();
    statement
        .query_map([], |row| {
            (0..width)
                .map(|i| {
                    Ok(match row.get_ref(i)? {
                        rusqlite::types::ValueRef::Text(text)
                        | rusqlite::types::ValueRef::Blob(text) => {
                            String::from_utf8_lossy(text).into_owned()
                        }
                        other => format!("{other:?}"),
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .concat()
}

fn reply(text: &str) -> Value {
    json!({"role": "assistant", "data": {"text": text}})
}

fn new_conversation(title: &str) -> NewConversation<'_> {
    NewConversation {
        vault_id: "v1",
        title,
        backend: "claude_cli",
        backend_model: None,
    }
}

fn message<'a>(conversation_id: &'a str, content: &'a Value, status: &'a str) -> NewMessage<'a> {
    NewMessage {
        id: None,
        conversation_id,
        role: "assistant",
        content,
        attachments: &EMPTY,
        tool_call_id: None,
        status,
    }
}

static EMPTY: Value = Value::Array(Vec::new());

/// Waits for `done`, yielding to the runtime between checks.
async fn eventually(what: &str, done: impl Fn() -> bool) {
    for _ in 0..2_000 {
        if done() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("never happened: {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_two_turn_conversation_leaves_no_title_or_text_in_plain_sqlite() {
    let f = Fixture::new(true);
    let vault = f.vault();
    let store = f.store(&vault);
    assert!(store.history_persisted());
    let records = store.records();
    let conversation = records
        .create_conversation(&new_conversation("Zebra launch plan"))
        .unwrap();
    for turn in ["walrus", "narwhal"] {
        let question = json!({"role": "user", "data": {"text": format!("Ask {turn}")}});
        let user = NewMessage {
            role: "user",
            ..message(&conversation.id, &question, "completed")
        };
        records.append_message(&user).unwrap();
        let empty = reply("");
        let streaming = records
            .append_message(&message(&conversation.id, &empty, "streaming"))
            .unwrap();
        let partial = reply(&format!("Partial {turn}"));
        let edit = MessageEdit {
            content: Some(&partial),
            attachments: None,
        };
        records.update_streaming(&streaming.id, &edit).unwrap();
        let answer = reply(&format!("Answer {turn}"));
        let edit = MessageEdit {
            content: Some(&answer),
            attachments: None,
        };
        records
            .finalize_message(&streaming.id, "completed", &edit)
            .unwrap();
    }
    assert_eq!(records.messages(&conversation.id).unwrap().len(), 4);

    let conn = f.plain();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM agent_messages"), 4);
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM outbox WHERE item_type LIKE 'agent_%'"
        ),
        5
    );
    for table in [
        "agent_conversations",
        "agent_messages",
        "sync_items",
        "outbox",
    ] {
        let text = cells(&conn, table).join("\n");
        for secret in ["Zebra", "walrus", "narwhal", "Partial", "Answer", "Ask"] {
            assert!(
                !text.contains(secret),
                "{table} holds `{secret}` in plain text"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_locked_keychain_keeps_history_in_memory_until_it_recovers() {
    let f = Fixture::new(true);
    f.keychain.locked.store(true, Ordering::SeqCst);
    let vault = f.vault();
    let store = f.store(&vault);
    assert!(!store.history_persisted());
    let before = store
        .records()
        .create_conversation(&new_conversation("In memory"))
        .unwrap();
    assert_eq!(
        store.records().conversations("v1").unwrap(),
        vec![before.clone()]
    );
    assert_eq!(
        count(&f.plain(), "SELECT COUNT(*) FROM agent_conversations"),
        0
    );

    f.keychain.locked.store(false, Ordering::SeqCst);
    f.recovered.send(()).unwrap();
    eventually("history persists", || store.history_persisted()).await;
    let after = store
        .records()
        .create_conversation(&new_conversation("On disk"))
        .unwrap();
    assert_eq!(
        store.records().conversations("v1").unwrap(),
        vec![after, before],
        "the conversation kept in memory moved to disk"
    );
    assert_eq!(
        count(&f.plain(), "SELECT COUNT(*) FROM agent_conversations"),
        2
    );
}

/// The keychain coming back in the middle of a turn moves what the agent kept in memory to
/// disk, ids and times kept: the streaming reply finishes, and nothing is lost or orphaned
/// (REVIEW-4884 item 2).
#[tokio::test(flavor = "multi_thread")]
async fn probe_a_reply_streaming_when_the_keychain_recovers_finishes_on_disk() {
    let f = Fixture::new(true);
    f.keychain.locked.store(true, Ordering::SeqCst);
    let vault = f.vault();
    let store = f.store(&vault);
    let conversation = store
        .records()
        .create_conversation(&new_conversation("Mid turn"))
        .unwrap();
    let gone = store
        .records()
        .create_conversation(&new_conversation("Deleted in memory"))
        .unwrap();
    assert!(store.records().delete_conversation(&gone.id).unwrap());
    let question = json!({"role": "user", "data": {"text": "Ask"}});
    let user = store
        .records()
        .append_message(&NewMessage {
            role: "user",
            ..message(&conversation.id, &question, "completed")
        })
        .unwrap();
    let partial = reply("Half");
    let streaming = store
        .records()
        .append_message(&message(&conversation.id, &partial, "streaming"))
        .unwrap();

    f.keychain.locked.store(false, Ordering::SeqCst);
    f.recovered.send(()).unwrap();
    eventually("history persists", || store.history_persisted()).await;

    let answer = reply("Whole answer");
    let edit = MessageEdit {
        content: Some(&answer),
        attachments: None,
    };
    let done = store
        .records()
        .finalize_message(&streaming.id, "completed", &edit)
        .unwrap();
    assert_eq!(
        store.records().conversations("v1").unwrap(),
        vec![conversation.clone()]
    );
    let mut messages = store.records().messages(&conversation.id).unwrap();
    let mut expected = vec![user, done];
    // Both were written within one millisecond, where the order falls to the ids.
    messages.sort_by(|a, b| a.id.cmp(&b.id));
    expected.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(messages, expected, "ids and times kept");
    let conn = f.plain();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM agent_conversations"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM agent_messages"), 2);
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM outbox WHERE item_type LIKE 'agent_%'"
        ),
        3,
        "the conversation and both final messages are queued once"
    );
}

/// A store dropped while it waits for the keychain lets go of the vault, so it can close and
/// reopen (REVIEW-4884 item 4).
#[tokio::test(flavor = "multi_thread")]
async fn probe_a_dropped_store_lets_go_of_its_vault() {
    let f = Fixture::new(true);
    f.keychain.locked.store(true, Ordering::SeqCst);
    let vault = f.vault();
    let store = f.store(&vault);
    assert!(!store.history_persisted());
    drop(store);
    eventually("the vault is released", || Arc::strong_count(&vault) == 1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn no_master_key_keeps_history_in_memory() {
    let f = Fixture::new(true);
    f.keychain.inner.delete(SecureStoreKey::MasterKey).unwrap();
    let vault = f.vault();
    let store = f.store(&vault);
    assert!(!store.history_persisted());
    store
        .records()
        .create_conversation(&new_conversation("Kept in memory"))
        .unwrap();
    assert_eq!(count(&f.plain(), "SELECT COUNT(*) FROM sync_items"), 0);
}

/// A crash in the middle of a reply keeps its text (#3545 D1), and the row never syncs.
#[tokio::test(flavor = "multi_thread")]
async fn a_streaming_reply_survives_a_reopen_and_is_never_queued() {
    let f = Fixture::new(true);
    let conversation_id = {
        let vault = f.vault();
        let store = f.store(&vault);
        let records = store.records();
        let conversation = records
            .create_conversation(&new_conversation("Crash"))
            .unwrap();
        let partial = reply("Half of the answer");
        records
            .append_message(&message(&conversation.id, &partial, "streaming"))
            .unwrap();
        conversation.id
    };
    let vault = f.vault();
    let store = f.store(&vault);
    let messages = store.records().messages(&conversation_id).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(
        (messages[0].status.as_str(), &messages[0].content),
        ("streaming", &reply("Half of the answer"))
    );
    let conn = f.plain();
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM outbox WHERE item_type = 'agent_message'"
        ),
        0
    );
}

/// Older and newer builds read each other's rows: content keys this build does not name survive.
#[tokio::test(flavor = "multi_thread")]
async fn content_keys_this_build_does_not_name_round_trip() {
    let f = Fixture::new(true);
    let vault = f.vault();
    let store = f.store(&vault);
    let records = store.records();
    let conversation = records
        .create_conversation(&new_conversation("Keys"))
        .unwrap();
    let content = json!({
        "role": "assistant",
        "data": {"text": "x", "reasoning": "r", "futureField": {"nested": [1, 2]}},
        "kind": "newer"
    });
    records
        .append_message(&message(&conversation.id, &content, "completed"))
        .unwrap();
    assert_eq!(
        records.messages(&conversation.id).unwrap()[0].content,
        content
    );
}

/// Unpaid writes stay on this device; the turn to paid queues each record once, the deleted
/// conversation as a delete (#3545 D2), and no streaming row.
#[tokio::test(flavor = "multi_thread")]
async fn unpaid_writes_stay_local_until_the_account_turns_paid() {
    let f = Fixture::new(false);
    let vault = f.vault();
    let store = f.store(&vault);
    let records = store.records();
    let kept = records
        .create_conversation(&new_conversation("Kept"))
        .unwrap();
    let gone = records
        .create_conversation(&new_conversation("Gone"))
        .unwrap();
    assert!(records.delete_conversation(&gone.id).unwrap());
    let done = reply("done");
    records
        .append_message(&message(&kept.id, &done, "completed"))
        .unwrap();
    records
        .append_message(&message(&kept.id, &done, "streaming"))
        .unwrap();
    let queued = |conn: &Connection| {
        count(
            conn,
            "SELECT COUNT(*) FROM outbox WHERE item_type LIKE 'agent_%'",
        )
    };
    assert_eq!(queued(&f.plain()), 0);

    let backfill = tokio::spawn(run_backfill(
        f.paid.subscribe(),
        vault.db_handle(),
        "v1".into(),
    ));
    f.paid.send(true).unwrap();
    eventually("the backfill queues", || queued(&f.plain()) == 3).await;
    let conn = f.plain();
    assert_eq!(
        count(
            &conn,
            &format!(
                "SELECT COUNT(*) FROM outbox WHERE item_id = '{}' AND op = 'delete'",
                gone.id
            )
        ),
        1
    );

    records
        .create_conversation(&new_conversation("Paid"))
        .unwrap();
    assert_eq!(queued(&conn), 4, "a paid write is queued at once");
    drop(f.paid);
    backfill.await.unwrap();
    assert_eq!(queued(&conn), 4);
}
