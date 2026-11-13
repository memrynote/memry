//! The portals surface (`portals:stamp-anchor`, `portals:search`, #4415), after Electron's
//! `portal-service.ts`, on a real vault under the running tier: a journal day's block stamped and
//! queued as the day's, a tag search over notes and days, and the locks both honour.
//!
//! | Test                                                              | Rule (Electron reference)                 |
//! | ----------------------------------------------------------------- | ----------------------------------------- |
//! | a day's block is stamped, queued as `journal`, written to its file | `stampAnchor` over `note_cache` days      |
//! | a day's stamp reaches the window that has the day open          | `stampAnchor` applies to the open doc     |
//! | a tag search lists days and at most 5 blocks of each note         | `findNotesByTag`, `TAG_ONLY_BLOCKS_PER_NOTE` |
//! | a locked note refuses a stamp and is left out of a search         | `isNoteLocked`: `locked`, `continue`      |

use std::sync::{Arc, Mutex};

use memry_core::domain::vault_locks::TargetKind;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::editor::{BARRIER, EditorHost, RELEASE, Subscriber};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::portals::{
    self, PortalSearchInput, PortalSearchView, StampAnchorView, StampRefusal,
};
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::config_path;
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, Transact as _, Update};

use crate::index_support::until;
use crate::journal_folder::daily;
use crate::notes_link_rewrite::id_at;
use crate::vault_env::{Env, env, indexed};

const DAY: &str = "journal/2025-01-02.md";
const PLAN: &str = "Notes/Plan.md";
const PLAN_TEXT: &str =
    "---\ntags: [daily]\n---\nOne\n\nTwo\n\nThree\n\nFour\n\nFive\n\nSix\n\nSeven\n";

/// A vault with a journal day and a note, both tagged `daily`, read by a running note index and
/// served to windows by an editor host.
fn vault() -> (Env, Arc<NotesService>, Arc<EditorHost>) {
    let kept = Mutex::new(None);
    let mut e = env(|store| {
        *kept.lock().unwrap() = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    std::fs::create_dir_all(e.vault.join(".memry")).unwrap();
    std::fs::write(config_path(&e.vault), daily("journal").to_string()).unwrap();
    e.write(
        DAY,
        "---\ntags: [daily]\n---\nMorning pages\n\nEvening walk\n",
    );
    e.write(PLAN, PLAN_TEXT);
    let store: Arc<dyn SecureStore> = kept.into_inner().unwrap().expect("the store");
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    let host = EditorHost::new(store.clone(), |_| {});
    host.register(&e.session);
    e.open();
    e.facts_until(indexed);
    index.reindex(|_| {}).expect("index the vault");
    let notes = NotesService::new(e.tier.clone(), store);
    (e, notes, host)
}

fn tagged(e: &Env) -> PortalSearchView {
    let open = e.session.current().unwrap();
    let input = PortalSearchInput {
        text: None,
        tag: Some("daily".to_owned()),
        limit: 50,
    };
    portals::search(&open, &input).expect("search")
}

fn stamp(e: &Env, notes: &NotesService, id: &str, block_id: &str) -> StampAnchorView {
    let open = e.session.current().unwrap();
    notes.stamp_anchor(&open, id, block_id).expect("stamp")
}

/// The item types the outbox queued body updates for `id` under.
fn queued_as(e: &Env, id: &str) -> Vec<String> {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            let mut stmt = conn
                .prepare("SELECT item_type FROM outbox WHERE item_id = ?1 AND op = 'crdt-update'")
                .unwrap();
            let types = stmt.query_map([id], |r| r.get::<_, String>(0)).unwrap();
            Ok(types.map(Result::unwrap).collect::<Vec<_>>())
        })
        .unwrap()
}

#[test]
fn a_journal_days_block_is_stamped_and_queued_as_the_days() {
    let (e, notes, _) = vault();
    let day = id_at(&e, DAY);
    let found = tagged(&e);
    let block = found
        .results
        .iter()
        .find(|hit| hit.note_id == day && hit.text == "Evening walk")
        .unwrap_or_else(|| panic!("the day's block is found: {found:?}"));

    let stamped = stamp(&e, &notes, &day, &block.block_id);
    let anchor = stamped
        .anchor
        .unwrap_or_else(|| panic!("a day is a markdown note: {:?}", stamped.reason));
    assert!(!queued_as(&e, &day).is_empty(), "the stamp is queued");
    assert!(
        queued_as(&e, &day).iter().all(|kind| kind == "journal"),
        "a day's body travels as the day's: {:?}",
        queued_as(&e, &day)
    );
    until("the day's file to take the anchor", || {
        e.read(DAY).contains(&format!("Evening walk ^{anchor}"))
    });
    assert_eq!(
        stamp(&e, &notes, &day, &block.block_id).anchor,
        Some(anchor),
        "a stamped block answers its anchor"
    );
}

#[test]
fn a_tag_search_lists_days_and_five_blocks_of_each_note() {
    let (e, _, _) = vault();
    let (day, plan) = (id_at(&e, DAY), id_at(&e, PLAN));
    let found = tagged(&e);
    let texts = |id: &str| -> Vec<&str> {
        found
            .results
            .iter()
            .filter(|hit| hit.note_id == id)
            .map(|hit| hit.text.as_str())
            .collect()
    };
    assert_eq!(texts(&day), ["Morning pages", "Evening walk"]);
    assert_eq!(texts(&plan), ["One", "Two", "Three", "Four", "Five"]);
    assert!(!found.truncated);
}

#[test]
fn a_locked_note_refuses_a_stamp_and_is_left_out_of_a_search() {
    let (e, notes, _) = vault();
    let plan = id_at(&e, PLAN);
    let block = tagged(&e)
        .results
        .into_iter()
        .find(|hit| hit.note_id == plan)
        .expect("the note's block");
    e.core()
        .locks()
        .set(TargetKind::Note, &plan, true, "device-a")
        .expect("lock");
    let queued = queued_as(&e, &plan).len();

    let refused = stamp(&e, &notes, &plan, &block.block_id);
    assert_eq!(
        (refused.anchor, refused.reason),
        (None, Some(StampRefusal::Locked))
    );
    assert_eq!(queued_as(&e, &plan).len(), queued, "nothing is written");
    assert!(!e.read(PLAN).contains(" ^"), "the file keeps no anchor");
    assert!(
        tagged(&e).results.iter().all(|hit| hit.note_id != plan),
        "a locked note's blocks are not offered"
    );
}

/// Electron's `stampAnchor` writes through the open document, so the editor showing the day
/// shows the anchor: here the stamp's update reaches the window subscribed to the day.
#[test]
fn a_journal_days_stamp_reaches_the_window_that_has_the_day_open() {
    let (e, notes, host) = vault();
    let day = id_at(&e, DAY);
    let block = tagged(&e)
        .results
        .into_iter()
        .find(|hit| hit.note_id == day && hit.text == "Morning pages")
        .expect("the day's block");
    let frames: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let sink = Arc::clone(&frames);
    let subscriber = Subscriber {
        window_label: "main".to_owned(),
        channel: Arc::new(move |frame| {
            sink.lock().unwrap().push(frame);
            true
        }),
    };
    let opened = host.open(&day, Some(&e.vault), subscriber).expect("open");
    let window = Doc::new();
    window
        .transact_mut()
        .apply_update(Update::decode_v1(&opened.state).unwrap())
        .unwrap();

    let anchor = stamp(&e, &notes, &day, &block.block_id)
        .anchor
        .expect("stamped");
    let updates = || -> Vec<Vec<u8>> {
        frames
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame[0] != BARRIER && frame[0] != RELEASE)
            .map(|frame| frame[1..].to_vec())
            .collect()
    };
    until("the window to hear the stamp", || !updates().is_empty());
    let updates = updates();
    assert!(
        updates
            .iter()
            .any(|update| update.windows(anchor.len()).any(|w| w == anchor.as_bytes())),
        "the update the window hears carries the anchor"
    );
    for update in updates {
        window
            .transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .expect("the window applies the stamp");
    }
}
