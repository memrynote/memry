//! The tag list and a tag's notes (#3530 13j) over a vault the running tier adopted and the note
//! index measured: a file's own `tags:` reach both, in Electron's shapes, reading them writes no
//! file, and a tag removed from a file outside the app leaves them once the index measured it.

mod device_key;
mod index_support;
mod vault_env;

use std::path::Path;
use std::sync::Arc;

use index_support::{all_indexed, until, with_task};
use memry_core::domain::tags::tag_key;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::error::{CoreError, FailureKind};
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::view::SortOrder;
use memry_desktop::session::OpenVault;
use memry_desktop::tags;
use memry_desktop::tags::view::{NotesByTagInput, TagSortBy, TagWithCountView};
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::hash::content_hash;
use tokio::sync::broadcast;
use vault_env::{Env, env, indexed};

const PLAN: &str = "---\ntags:\n  - Work\n  - plan\n---\nFirst line\n";
const OTHER: &str = "---\ntags: [work]\n---\nOther text\n";
const UNTAGGED: &str = "Nothing here\n";
/// Under `work`, so a read of `work` alone leaves it out.
const DEEP: &str = "---\ntags: [Work/deep]\n---\nDeep\n";

/// A vault of three files, adopted by the identity, then measured by the note index.
fn opened() -> (Env, OpenVault) {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("Plan.md", PLAN);
    e.write("Other.md", OTHER);
    e.write("Untagged.md", UNTAGGED);
    e.write("Deep.md", DEEP);
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    reindex(&e, &open);
    (e, open)
}

/// A pass of the note index over `open` that measures every note it has not measured as it is.
fn reindex(e: &Env, open: &OpenVault) {
    let (sender, receiver) = broadcast::channel(4);
    with_task(open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("every file measured", || all_indexed(e));
    });
}

fn by_tag(tag: &str) -> NotesByTagInput {
    NotesByTagInput {
        tag: tag.to_owned(),
        sort_by: None,
        sort_order: None,
        include_descendants: None,
    }
}

fn tag<'a>(list: &'a [TagWithCountView], name: &str) -> &'a TagWithCountView {
    list.iter()
        .find(|tag| tag_key(&tag.name) == tag_key(name))
        .unwrap_or_else(|| panic!("{name} is listed"))
}

#[test]
fn a_files_own_tags_reach_the_list_and_a_tags_notes() {
    let (mut e, open) = opened();
    let list = tags::all_with_counts(&open).unwrap();
    assert_eq!(list.len(), 3, "{list:?}");
    assert_eq!(tag(&list, "work").count, 2, "one tag in either case");
    assert_eq!(tag(&list, "plan").count, 1);

    let input = NotesByTagInput {
        tag: "WORK".to_owned(),
        sort_by: Some(TagSortBy::Title),
        sort_order: Some(SortOrder::Desc),
        include_descendants: None,
    };
    let by_tag = tags::notes_by_tag(&open, &input).unwrap();
    assert_eq!((by_tag.tag.as_str(), by_tag.count), ("WORK", 2));
    assert!(by_tag.pinned_notes.is_empty());
    let titles: Vec<&str> = by_tag
        .unpinned_notes
        .iter()
        .map(|n| n.title.as_str())
        .collect();
    assert_eq!(titles, ["Plan", "Other"]);
    let deep = NotesByTagInput {
        include_descendants: Some(true),
        ..input
    };
    assert_eq!(tags::notes_by_tag(&open, &deep).unwrap().count, 3);
    let plan = &by_tag.unpinned_notes[0];
    assert_eq!(plan.path, "Plan.md");
    assert_eq!(plan.tags, ["Work", "plan"]);
    assert_eq!(plan.word_count, 2);
    // Instants as Electron's index text columns carry them.
    for instant in [&plan.created, &plan.modified] {
        assert!(
            instant.len() == 24 && instant.ends_with('Z'),
            "an ISO instant: {instant}"
        );
    }
    for (path, text) in [
        ("Plan.md", PLAN),
        ("Other.md", OTHER),
        ("Untagged.md", UNTAGGED),
        ("Deep.md", DEEP),
    ] {
        assert_eq!(e.read(path), text, "{path} is untouched");
    }
    e.close();
}

/// The probe of #3820's review: a note made in the app with a tag, the tag then removed from
/// its file in another editor. The record keeps the tag (no outside edit reaches it), so only
/// the file's measure can take it off the list.
#[test]
fn a_tag_removed_from_the_file_outside_the_app_leaves_the_list_once_measured() {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    let notes = NotesService::with_trash(e.tier.clone(), kept.expect("the store"), |_: &Path| {
        Err("no bin".to_owned())
    });
    let note = notes
        .create(
            &open,
            NewNoteFile {
                title: "Plan".into(),
                content: "Body".into(),
                tags: vec!["x".into()],
                ..NewNoteFile::default()
            },
        )
        .unwrap();
    reindex(&e, &open);
    assert_eq!(tag(&tags::all_with_counts(&open).unwrap(), "x").count, 1);

    let outside = "Body\n";
    e.write(&note.path, outside);
    // The watcher's report of these bytes, not the echo of the create's own write.
    let hash = content_hash(outside);
    e.facts_until(|fact| {
        matches!(fact, Applied::Changed { note_id, content_hash: Some(read), .. }
            if *note_id == note.id && *read == hash)
    });
    reindex(&e, &open);
    let list = tags::all_with_counts(&open).unwrap();
    assert!(list.iter().all(|tag| tag_key(&tag.name) != "x"), "{list:?}");
    assert_eq!(tags::notes_by_tag(&open, &by_tag("x")).unwrap().count, 0);
    e.close();
}

#[test]
fn an_empty_tag_is_refused() {
    let (mut e, open) = opened();
    let refused = tags::notes_by_tag(&open, &by_tag("")).unwrap_err();
    assert_eq!(refused.kind_and_code(), (FailureKind::Invalid, "invalid"));
    e.close();
}
