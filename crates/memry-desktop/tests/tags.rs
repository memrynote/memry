//! The tag list, a tag's notes and the tag hub (#3530 13j) over a vault the running tier adopted
//! and the note index measured: a file's own `tags:` reach the list and a tag's notes in
//! Electron's shapes, reading them writes no file, a tag removed from a file outside the app
//! leaves them once the index measured it, and the hub's edits change records only, never a
//! note file.

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
use memry_desktop::tags::view::{
    CategoryOrderInput, NotesByTagInput, ReorderInput, TagAssignmentInput, TagSortBy,
    TagWithCountView,
};
use memry_desktop::tags::{self, Hub};
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
fn opened() -> (Env, OpenVault, Arc<dyn SecureStore>) {
    let mut kept = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.write("Plan.md", PLAN);
    e.write("Other.md", OTHER);
    e.write("Untagged.md", UNTAGGED);
    e.write("Deep.md", DEEP);
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    reindex(&e, &open);
    (e, open, kept.expect("the store"))
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
    let (mut e, open, _) = opened();
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
    let (mut e, open, _) = opened();
    let refused = tags::notes_by_tag(&open, &by_tag("")).unwrap_err();
    assert_eq!(refused.kind_and_code(), (FailureKind::Invalid, "invalid"));
    e.close();
}

#[test]
fn the_hubs_edits_change_records_and_never_a_note_file() {
    let (mut e, open, store) = opened();
    let hub = Hub::open(&open, store).unwrap();

    hub.set_color("WORK", "teal").unwrap();
    hub.set_icon("work", Some("icon:Star")).unwrap();
    let category = hub.create_category("  Areas ").unwrap();
    assert_eq!((category.name.as_str(), category.tag_count), ("Areas", 0));
    let second = hub.create_category("Later").unwrap();
    hub.reorder(&ReorderInput {
        tags: Some(vec![TagAssignmentInput {
            tag: "work".to_owned(),
            category_id: Some(category.id.clone()),
            sort_order: 3,
        }]),
        categories: Some(vec![
            CategoryOrderInput {
                id: second.id.clone(),
                sort_order: 0,
            },
            CategoryOrderInput {
                id: category.id.clone(),
                sort_order: 1,
            },
        ]),
    })
    .unwrap();

    let list = tags::all_with_counts(&open).unwrap();
    let work = tag(&list, "work");
    assert_eq!(
        (work.color.as_str(), work.icon.as_deref()),
        ("teal", Some("icon:Star"))
    );
    assert_eq!(
        (work.category_id.as_deref(), work.sort_order),
        (Some(category.id.as_str()), 3)
    );
    assert_eq!(
        work.count, 2,
        "a definition joins its tag, whatever its case"
    );
    let rows: Vec<(String, i64)> = tags::categories(&open)
        .unwrap()
        .into_iter()
        .map(|c| (c.name, c.tag_count))
        .collect();
    assert_eq!(rows, [("Later".to_owned(), 0), ("Areas".to_owned(), 1)]);
    assert_eq!(
        tags::notes_by_tag(&open, &by_tag("work")).unwrap().color,
        "teal"
    );

    hub.rename_category(&category.id, "Fields").unwrap();
    let names: Vec<String> = tags::categories(&open)
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();
    assert_eq!(names, ["Later", "Fields"]);
    hub.delete_category(&category.id).unwrap();
    let list = tags::all_with_counts(&open).unwrap();
    assert_eq!(
        tag(&list, "work").category_id,
        None,
        "its tags are uncategorised"
    );
    let names: Vec<String> = tags::categories(&open)
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();
    assert_eq!(names, ["Later"]);

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

/// A tag the hub defines before any note carries it is listed as it was typed (Electron's
/// `getOrCreateTag` keeps the trimmed spelling), from a colour and from a drag alike.
#[test]
fn a_tag_the_hub_defines_keeps_its_capitals() {
    let (mut e, open, store) = opened();
    let hub = Hub::open(&open, store).unwrap();
    let category = hub.create_category("Areas").unwrap();
    hub.set_color(" Roadmap ", "teal").unwrap();
    hub.reorder(&ReorderInput {
        tags: Some(vec![TagAssignmentInput {
            tag: "Q3 Goals".to_owned(),
            category_id: Some(category.id.clone()),
            sort_order: 0,
        }]),
        categories: None,
    })
    .unwrap();
    let list = tags::all_with_counts(&open).unwrap();
    assert_eq!(tag(&list, "roadmap").name, "Roadmap");
    let goals = tag(&list, "q3 goals");
    assert_eq!(
        (goals.name.as_str(), goals.category_id.as_deref()),
        ("Q3 Goals", Some(category.id.as_str()))
    );
    e.close();
}

#[test]
fn the_hub_refuses_a_blank_tag_and_an_empty_icon() {
    let (mut e, open, store) = opened();
    let hub = Hub::open(&open, store).unwrap();
    let refused = |error: tags::TagsError| error.kind_and_code();
    assert_eq!(
        refused(hub.set_color("  ", "teal").unwrap_err()),
        (FailureKind::Invalid, "invalid")
    );
    assert_eq!(
        refused(hub.set_color("work", "").unwrap_err()),
        (FailureKind::Invalid, "invalid")
    );
    assert_eq!(
        refused(hub.set_icon("work", Some("")).unwrap_err()),
        (FailureKind::Invalid, "invalid")
    );
    let blank = ReorderInput {
        tags: Some(vec![TagAssignmentInput {
            tag: " ".to_owned(),
            category_id: None,
            sort_order: 0,
        }]),
        categories: None,
    };
    assert_eq!(
        refused(hub.reorder(&blank).unwrap_err()),
        (FailureKind::Invalid, "invalid")
    );
    // Nothing was written: no definition, so the list is the files' tags alone.
    let list = tags::all_with_counts(&open).unwrap();
    assert_eq!(list.len(), 3);
    assert!(list.iter().all(|tag| tag.icon.is_none()));
    e.close();
}
