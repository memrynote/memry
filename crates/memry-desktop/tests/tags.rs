//! The tag list and a tag's notes (#3530 13j) over a vault the running tier adopted and the note
//! index measured: a file's own `tags:` reach both, in Electron's shapes, and reading them writes
//! no file.

mod device_key;
mod index_support;
mod vault_env;

use index_support::{all_indexed, until, with_task};
use memry_core::domain::tags::tag_key;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::view::SortOrder;
use memry_desktop::session::OpenVault;
use memry_desktop::tags;
use memry_desktop::tags::view::{NotesByTagInput, TagSortBy, TagWithCountView};
use memry_desktop::vault::consumer::Applied;
use tokio::sync::broadcast;
use vault_env::{Env, env, indexed};

const PLAN: &str = "---\ntags:\n  - Work\n  - plan\n---\nFirst line\n";
const OTHER: &str = "---\ntags: [work]\n---\nOther text\n";
const UNTAGGED: &str = "Nothing here\n";

/// A vault of three files, adopted by the identity, then measured by the note index.
fn opened() -> (Env, OpenVault) {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("Plan.md", PLAN);
    e.write("Other.md", OTHER);
    e.write("Untagged.md", UNTAGGED);
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    let (sender, receiver) = broadcast::channel(4);
    with_task(&open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("every file measured", || all_indexed(&e));
    });
    (e, open)
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
    assert_eq!(list.len(), 2, "{list:?}");
    assert_eq!(tag(&list, "work").count, 2, "one tag in either case");
    assert_eq!(tag(&list, "plan").count, 1);

    let input = NotesByTagInput {
        tag: "WORK".to_owned(),
        sort_by: Some(TagSortBy::Title),
        sort_order: Some(SortOrder::Asc),
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
    assert_eq!(titles, ["Other", "Plan"]);
    let plan = &by_tag.unpinned_notes[1];
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
    ] {
        assert_eq!(e.read(path), text, "{path} is untouched");
    }
    e.close();
}
