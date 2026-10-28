//! A crash between a body commit and its write-back (`vault::writeback`, "A crash or a
//! forced exit leaves files behind their bodies" and "Every open brings the files left
//! behind"): a child process opens the vault, commits a page from sync as the body pull does,
//! schedules the write-back as the sync driver does, and aborts inside the debounce. The next
//! open writes the file from the committed document, and the open after it writes nothing.

mod device_key;
mod vault_env;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{BODY_FRAGMENT, DocumentRegistry, update_log};
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::{Applied, ChangeSource, VaultTier};
use memry_desktop::vault::writeback::DEBOUNCE;
use vault_env::{QUIET, WAIT, creates, env, indexed};

const VAULT: &str = "MEMRY_CRASH_VAULT";
const APP: &str = "MEMRY_CRASH_APP";
const NOTE: &str = "MEMRY_CRASH_NOTE";
const CHILD: &str = "the_child_commits_a_page_schedules_its_write_back_and_aborts";

fn app_changed(id: &str) -> impl Fn(&Applied) -> bool + '_ {
    move |f| matches!(f, Applied::Changed { note_id, source: ChangeSource::App, .. } if note_id == id)
}

#[test]
fn a_page_committed_before_a_crash_reaches_the_file_on_the_next_open() {
    let made = Mutex::new(None);
    let mut e = env(|store| {
        let identity = creates(store);
        *made.lock().unwrap() = Some(identity.clone());
        Some(identity)
    });
    drop(made);
    e.write("n.md", "first words\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    e.close();

    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", CHILD, "--nocapture"])
        .env(VAULT, &e.vault)
        .env(APP, e.vault.parent().unwrap().join("app"))
        .env(NOTE, &id)
        .status()
        .unwrap();
    assert!(!status.success(), "the child did not abort: {status}");
    assert_eq!(e.read("n.md"), "first words\n", "the child wrote the file");

    e.open();
    e.facts_until(app_changed(&id));
    let converter = Converter::new(CalloutTypes::new(Vec::new()));
    let Ok(BodyRead::Body(body)) =
        e.core()
            .write_back()
            .body(&converter, &id, "n.md", "first words\n")
    else {
        panic!("the committed document has no body to write");
    };
    // The file is the converter's markdown with the final newline the file had.
    assert_eq!(body.markdown, "first words\n\nfrom the page");
    assert_eq!(e.read("n.md"), format!("{}\n", body.markdown));

    e.close();
    let mtime = modified(&e.vault.join("n.md"));
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(DEBOUNCE + QUIET);
    let again = e.drain();
    assert!(
        !again.iter().any(|f| matches!(
            f,
            Applied::Changed {
                source: ChangeSource::App,
                ..
            }
        )),
        "the second open wrote: {again:?}"
    );
    assert_eq!(modified(&e.vault.join("n.md")), mtime);
}

/// The child half: run only by the test above, in its own process.
#[test]
#[ignore = "the crash test runs it in a child process"]
fn the_child_commits_a_page_schedules_its_write_back_and_aborts() {
    let vault = PathBuf::from(std::env::var(VAULT).unwrap());
    let app = PathBuf::from(std::env::var(APP).unwrap());
    let id = std::env::var(NOTE).unwrap();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(app.join("memry-config.json"))));
    let session = Session::new(registry);
    let tier = VaultTier::new(device_key::with_device_key());
    tier.register(&session);
    let mut facts = tier.subscribe();
    let opened = session.open(&vault, OpenSource::Select).unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while !matches!(facts.try_recv(), Ok(Applied::Indexed { .. })) {
        assert!(
            std::time::Instant::now() < deadline,
            "the vault never indexed"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    commit_page(&opened.vault.vault, &id, "from the page");
    tier.schedule(&id);
    std::process::abort();
}

/// Another device's paragraph, stored as the body pull stores a page: server namespace, this
/// device's clock.
fn commit_page(core: &memry_core::api::vault::Vault, id: &str, text: &str) {
    let authored: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let sink: UpdateSink = {
        let authored = authored.clone();
        Arc::new(move |_, bytes: &[u8]| authored.lock().unwrap().push(bytes.to_vec()))
    };
    let peer = DocumentRegistry::new("peer-device", sink)
        .get_or_open(id)
        .unwrap();
    let db = core.db_handle();
    let doc_id = id.to_owned();
    let plan = db
        .call_blocking(move |conn| Ok(update_log::load_plan(conn, &doc_id).unwrap()))
        .unwrap();
    for blob in plan.blobs() {
        peer.apply_durable_update(blob).unwrap();
    }
    let text = text.to_owned();
    peer.write(move |txn| {
        use yrs::{XmlElementPrelim, XmlFragment as _, XmlOut, XmlTextPrelim};
        let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
        let Some(XmlOut::Element(group)) = fragment.get(txn, 0) else {
            panic!("a seeded body starts with its block group");
        };
        let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
        let block = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
        block.push_back(txn, XmlTextPrelim::new(text.as_str()));
    })
    .unwrap();
    let updates = authored.lock().unwrap().clone();
    let doc_id = id.to_owned();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap());
    db.call_blocking(move |conn| {
        for (at, update) in updates.iter().enumerate() {
            update_log::append_server_update(conn, &doc_id, 1 + at as i64, update, now).unwrap();
        }
        Ok(())
    })
    .unwrap();
}

fn modified(path: &Path) -> SystemTime {
    std::fs::metadata(path).unwrap().modified().unwrap()
}
