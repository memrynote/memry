use super::*;

fn item(id: &str, kind: ItemKind, tags: &[&str]) -> TagItem {
    TagItem {
        id: id.to_owned(),
        kind,
        title: id.to_owned(),
        emoji: None,
        path: (kind == ItemKind::Note).then(|| format!("a/{id}.md")),
        tags: tags.iter().map(|t| (*t).to_owned()).collect(),
        container: None,
        created_at: None,
        modified_at: None,
        file_type: "markdown".to_owned(),
    }
}

/// `computeRelativeFolder`, the cases of `folder-view-handlers.test.ts` (#1204).
#[test]
fn a_rows_folder_is_relative_to_the_viewed_one() {
    assert_eq!(
        relative_folder("projects/2024/note.md", "projects"),
        "/2024"
    );
    assert_eq!(relative_folder("projects/note.md", "projects"), "/");
    assert_eq!(relative_folder("projects/a/b/n.md", "projects"), "/a/b");
    assert_eq!(relative_folder("projects/a/n.md", ""), "/projects/a");
    assert_eq!(relative_folder("n.md", ""), "/");
    // The folder's own note sits beside it, so it reads as in it.
    assert_eq!(relative_folder("projects.md", "projects"), "/");
    // A prefix is not a parent: `projects-old` is not under `projects`.
    assert_eq!(relative_folder("projects-old/n.md", "projects"), "/");
}

/// `pairedFolderPath` of `@memry/shared/folder-note`.
#[test]
fn only_a_markdown_note_that_is_no_day_pairs_with_its_folder() {
    assert_eq!(
        paired_folder_path("Plan.md", "markdown", false),
        Some("Plan")
    );
    assert_eq!(
        paired_folder_path("a/Plan.v2.md", "markdown", false),
        Some("a/Plan.v2")
    );
    assert_eq!(
        paired_folder_path("a/.md", "markdown", false),
        Some("a/.md")
    );
    assert_eq!(
        paired_folder_path("a.b/Plan", "markdown", false),
        Some("a.b/Plan")
    );
    assert_eq!(paired_folder_path("Plan.pdf", "pdf", false), None);
    assert_eq!(paired_folder_path("2026-01-01.md", "markdown", true), None);
}

/// `listTagItems`: a tag or a `/` tag under it, never a longer name; every `and_tags` entry by
/// the same rule, a blank one and the tag itself ignored.
#[test]
fn a_tag_lists_its_items_and_those_under_it_narrowed_by_every_and_tag() {
    let items = vec![
        item("own", ItemKind::Note, &["Work"]),
        item("under", ItemKind::Task, &["work/meetings", "urgent"]),
        item("longer", ItemKind::Note, &["workshop"]),
        item("inbox", ItemKind::Inbox, &["WORK", "Urgent/today"]),
    ];
    let ids = |found: Vec<&TagItem>| found.iter().map(|i| i.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(tagged(&items, "work", &[])), ["own", "under", "inbox"]);
    let and = vec!["urgent".to_owned(), " ".to_owned(), "Work".to_owned()];
    assert_eq!(ids(tagged(&items, " Work ", &and)), ["under", "inbox"]);
    assert!(tagged(&items, "work", &["missing".to_owned()]).is_empty());
}

/// `tagItemToRow`: a task and an inbox item get a path of their own, no word count.
#[test]
fn a_tag_item_becomes_a_row_with_its_kind_and_path() {
    let task = item("t1", ItemKind::Task, &["work"]).into_row(Map::new(), None);
    assert_eq!(
        (task.path.as_str(), task.kind),
        ("/tasks/t1", Some(ItemKind::Task))
    );
    let inbox = item("i1", ItemKind::Inbox, &["work"]).into_row(Map::new(), None);
    assert_eq!(inbox.path, "/inbox/i1");
    let mut note = item("n1", ItemKind::Note, &["work"]);
    note.container = Some("a".to_owned());
    let note = note.into_row(Map::new(), Some("employee".to_owned()));
    assert_eq!((note.path.as_str(), note.folder.as_str()), ("a/n1.md", "a"));
    assert_eq!(note.via_tag.as_deref(), Some("employee"));
    assert_eq!(note.word_count, 0);
}

/// `fetchPropertyCounts` + `toAvailableProperties`: most used first, ties as first met, the
/// first holder's type; a tag's unheld fields follow at zero.
#[test]
fn properties_count_their_holders_most_used_first() {
    let held = [
        ("status", "select"),
        ("due", "date"),
        ("due", "text"),
        ("rating", "number"),
        ("due", "date"),
        ("status", "select"),
    ];
    let fields = vec![
        ("Role".to_owned(), "text".to_owned()),
        ("due".to_owned(), "text".to_owned()),
    ];
    let counts = property_counts(held.into_iter(), &fields);
    let shown: Vec<(&str, &str, u32)> = counts
        .iter()
        .map(|c| (c.name.as_str(), c.type_name.as_str(), c.usage_count))
        .collect();
    assert_eq!(
        shown,
        [
            ("due", "date", 3),
            ("status", "select", 2),
            ("rating", "number", 1),
            ("Role", "text", 0),
        ]
    );
}
