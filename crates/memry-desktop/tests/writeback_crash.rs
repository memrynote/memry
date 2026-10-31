//! A crash between a body commit and its write-back, and between a note's deletion and its
//! file's (`vault::writeback`, "A crash or a forced exit leaves files behind their bodies",
//! "Every open brings the files left behind" and "A deleted note's file goes to the OS
//! trash"): a child process opens the vault, commits a page from sync as the body pull does,
//! schedules the write-back as the sync driver does, deletes a second note, and aborts inside
//! the debounce. The next open writes the first file from the committed document and moves
//! the second to the OS trash, and the open after it writes nothing.

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
const DELETED: &str = "MEMRY_CRASH_DELETED";
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
    // A name of this run only, so the test finds its own file in the OS trash.
    let gone = format!(
        "gone-{}-{}.md",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    e.write("n.md", "first words\n");
    e.write(&gone, "deleted on another device\n");
    e.open();
    e.facts_until(indexed);
    let rows = e.rows();
    let id_of = |path: &str| rows.iter().find(|(_, p)| p == path).unwrap().0.clone();
    let (id, deleted) = (id_of("n.md"), id_of(&gone));
    e.close();

    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", CHILD, "--nocapture"])
        .env(VAULT, &e.vault)
        .env(APP, e.vault.parent().unwrap().join("app"))
        .env(NOTE, &id)
        .env(DELETED, &deleted)
        .status()
        .unwrap();
    assert!(!status.success(), "the child did not abort: {status}");
    assert_eq!(e.read("n.md"), "first words\n", "the child wrote the file");
    assert!(
        e.vault.join(&gone).exists(),
        "the child removed the deleted note's file"
    );

    // Empties this run's file from the real trash however the test ends.
    let _purge = Purge(gone.clone());
    e.open();
    e.facts_until(app_changed(&id));
    let converter = Converter::new(CalloutTypes::new(Vec::new()));
    let Ok(BodyRead::Body(body)) = e.core().write_back().body(
        &converter,
        &id,
        "n.md",
        "first words\n",
        &memry_core::markdown::convert::NoEmbeds,
    ) else {
        panic!("the committed document has no body to write");
    };
    // The file is the converter's markdown with the final newline the file had.
    assert_eq!(body.markdown, "first words\n\nfrom the page");
    assert_eq!(e.read("n.md"), format!("{}\n", body.markdown));
    assert!(
        !e.vault.join(&gone).exists(),
        "the deleted note's file is still in the vault"
    );
    assert_in_trash(&e.vault, &gone, "deleted on another device\n");
    assert!(e.core().note_files().by_id(&deleted).unwrap().is_none());

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
    let deleted = std::env::var(DELETED).unwrap();
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
    opened
        .vault
        .vault
        .notes_writer(device_key::with_device_key())
        .unwrap()
        .delete(deleted)
        .unwrap();
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

/// Asserts `name`, taken from `vault`, is in the OS trash with `text` in it.
#[cfg(any(windows, all(unix, not(target_os = "macos"))))]
fn assert_in_trash(vault: &Path, name: &str, text: &str) {
    let _ = text;
    let parent = vault.canonicalize().unwrap();
    let items = trash_items(name);
    assert!(
        items
            .iter()
            .any(|item| item.original_parent.canonicalize().ok().as_ref() == Some(&parent)),
        "{name} is not in the trash: {items:?}"
    );
}

#[cfg(any(windows, all(unix, not(target_os = "macos"))))]
fn trash_items(name: &str) -> Vec<trash::TrashItem> {
    trash::os_limited::list()
        .unwrap()
        .into_iter()
        .filter(|item| item.name == name)
        .collect()
}

/// The Finder's Trash has no list call: the file is at `~/.Trash/<name>` (the name is this
/// run's own, so the Finder has no reason to rename it). Reading there needs Full Disk Access
/// for the process running the test.
#[cfg(target_os = "macos")]
fn assert_in_trash(_vault: &Path, name: &str, text: &str) {
    match std::fs::read_to_string(mac_trash(name)) {
        Ok(found) => assert_eq!(found, text, "{name} in the trash holds other bytes"),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => panic!(
            "~/.Trash cannot be read: give the process running the test Full Disk Access \
             ({error})"
        ),
        Err(error) => panic!("{name} is not in the trash: {error}"),
    }
}

#[cfg(target_os = "macos")]
fn mac_trash(name: &str) -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap())
        .join(".Trash")
        .join(name)
}

/// This run's file, emptied from the real trash when the test ends, a failed one included.
struct Purge(String);

impl Drop for Purge {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        let _ = std::fs::remove_file(mac_trash(&self.0));
        #[cfg(any(windows, all(unix, not(target_os = "macos"))))]
        if let Ok(items) = std::panic::catch_unwind(|| trash_items(&self.0)) {
            let _ = trash::os_limited::purge_all(items);
        }
    }
}

fn modified(path: &Path) -> SystemTime {
    std::fs::metadata(path).unwrap().modified().unwrap()
}
