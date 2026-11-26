//! A project link, unlink, rename or delete reaches a linked markdown note's file (#5348
//! REVIEW-5348), over a real session, tier, watcher and index task. The panel reads the file, so
//! a file that kept the old names showed none, and the next panel edit of `project` unlinked
//! the note (`writeNames`, `propagateProjectRename`, `propagateProjectDelete`).

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::session::OpenVault;
use memry_desktop::tasks::project_contract::{ProjectMutation, ProjectWithStatusesView};
use memry_desktop::tasks::project_notes::ProjectWrite;
use memry_desktop::tasks::service::{TaskEvent, TasksService};
use memry_desktop::vault::hash::content_hash;
use serde_json::{Map, Value, json};
use vault_env::{Env, env, indexed};

struct Fixture {
    e: Env,
    open: OpenVault,
    notes: Arc<NotesService>,
    tasks: TasksService,
    _index: Arc<NoteIndex>,
    id: String,
}

fn opened(rel: &str, text: &str) -> Fixture {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.write(rel, text);
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let open = e.session.current().unwrap();
    let tasks = TasksService::open(&open, store).unwrap();
    let id = e.rows().into_iter().find(|(_, p)| p == rel).unwrap().0;
    until("every file read", || index_support::all_indexed(&e));
    Fixture {
        e,
        open,
        notes,
        tasks,
        _index: index,
        id,
    }
}

fn input<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

impl Fixture {
    /// Runs the command's write as the shell does; answers the envelope and the events sent.
    fn finish(&self, write: ProjectWrite) -> (ProjectMutation, Vec<TaskEvent>) {
        let mut events = Vec::new();
        let mutation = write.finish(&self.notes, &self.open, |written| {
            events.extend(written.events.clone());
        });
        (mutation, events)
    }

    fn project(&self, name: &str) -> String {
        let created = self
            .tasks
            .create_project(input(json!({ "name": name })))
            .unwrap();
        let project: ProjectWithStatusesView = created.mutation.project.unwrap();
        project.project.id
    }

    fn link(&self, project: &str) -> (ProjectMutation, Vec<TaskEvent>) {
        let link = input(json!({ "projectId": project, "itemType": "note", "itemId": self.id }));
        self.finish(self.tasks.link_project_item(link).unwrap())
    }

    /// The `project` names the panel shows: the file's.
    fn shown(&self) -> Map<String, Value> {
        self.notes
            .properties(&self.open, &self.id)
            .unwrap()
            .into_iter()
            .map(|p| (p.name, p.value))
            .collect()
    }

    /// The user adds `name` to the `project` the panel shows.
    fn add_in_panel(&self, name: &str) {
        let base = self.shown();
        let mut next = base.clone();
        let mut names = next
            .get("project")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        names.push(json!(name));
        next.insert("project".into(), Value::Array(names));
        self.notes
            .set_properties(&self.open, &self.id, next, base)
            .unwrap();
    }

    fn links(&self, project: &str) -> usize {
        self.tasks.project_links(project).unwrap().len()
    }

    fn record_names(&self) -> Option<Value> {
        let files = self.e.core().note_files();
        let listed = files.listed_by_id(&self.id).unwrap().unwrap();
        listed.properties.get("project").cloned()
    }

    /// An outside edit of the body, which the index reads (a reindex of the note).
    fn reindex(&self, rel: &str) {
        let text = self.e.read(rel).replace("# Plan", "# Plan\n\nMore.");
        self.outside(rel, &text);
    }

    /// Writes `rel` outside the app and waits until the index read it.
    fn outside(&self, rel: &str, text: &str) {
        self.e.write(rel, text);
        let search = self.open.search.clone();
        until("the outside edit read", || {
            search
                .note_stats(&self.id)
                .unwrap()
                .and_then(|stored| stored.file_hash)
                == Some(content_hash(text))
        });
    }
}

const PLAN: &str = "---\nstage: Draft\n---\n# Plan\n";

#[test]
fn a_link_and_an_unlink_reach_the_file_and_a_later_panel_edit_keeps_the_link() {
    let f = opened("Plan.md", PLAN);
    let garden = f.project("Garden");

    let (linked, events) = f.link(&garden);
    assert!(linked.success, "{linked:?}");
    assert_eq!(events, [TaskEvent::ProjectUpdated(garden.clone())]);
    let text = f.e.read("Plan.md");
    assert!(text.contains("stage: Draft"), "{text}");
    assert!(
        text.contains("Garden"),
        "the file names the project: {text}"
    );
    assert_eq!(f.shown().get("project"), Some(&json!(["Garden"])));
    assert_eq!(f.links(&garden), 1);

    f.add_in_panel("Other");
    assert_eq!(f.links(&garden), 1, "the panel edit keeps the link");
    f.reindex("Plan.md");
    assert_eq!(f.record_names(), Some(json!(["Garden", "Other"])));
    assert_eq!(f.links(&garden), 1);

    let unlink = input(json!({ "projectId": garden, "itemType": "note", "itemId": f.id }));
    let (unlinked, _) = f.finish(f.tasks.unlink_project_item(unlink).unwrap());
    assert!(unlinked.success);
    assert_eq!(f.shown().get("project"), Some(&json!(["Other"])));
    assert_eq!(f.links(&garden), 0);
}

#[test]
fn a_rename_reaches_the_file_and_a_later_panel_edit_keeps_the_link() {
    let f = opened("Plan.md", PLAN);
    let garden = f.project("Garden");
    f.link(&garden);

    let rename = input(json!({ "id": garden, "name": "Orchard" }));
    let (renamed, events) = f.finish(f.tasks.update_project(rename).unwrap());
    assert!(renamed.success);
    assert_eq!(events, [TaskEvent::ProjectUpdated(garden.clone())]);
    let text = f.e.read("Plan.md");
    assert!(
        text.contains("Orchard") && !text.contains("Garden"),
        "{text}"
    );
    assert_eq!(f.shown().get("project"), Some(&json!(["Orchard"])));

    f.add_in_panel("Other");
    f.reindex("Plan.md");
    assert_eq!(f.record_names(), Some(json!(["Orchard", "Other"])));
    assert_eq!(f.links(&garden), 1, "the renamed project keeps its note");
}

#[test]
fn a_delete_takes_the_name_out_of_the_file() {
    let rel = "Plan.md";
    let f = opened(rel, PLAN);
    let garden = f.project("Garden");
    f.outside(
        rel,
        "---\nstage: Draft\nproject:\n  - Garden\n---\n# Plan\n",
    );
    until("the file's name linked the note", || f.links(&garden) == 1);

    let (deleted, events) = f.finish(f.tasks.delete_project(&garden).unwrap());
    assert!(deleted.success);
    assert_eq!(events, [TaskEvent::ProjectDeleted(garden.clone())]);
    let text = f.e.read(rel);
    assert!(!text.contains("Garden"), "{text}");
    assert_eq!(f.shown().get("project"), Some(&json!([])));

    // A later project of the same name does not take the note back.
    let again = f.project("Garden");
    f.add_in_panel("Other");
    f.reindex(rel);
    assert_eq!(f.record_names(), Some(json!(["Other"])));
    assert_eq!(f.links(&again), 0);
}

/// A rename whose note file cannot be written: the project write and its events stand, the
/// note keeps its file and record together, and the failure is logged after the retries.
#[cfg(unix)]
#[test]
fn a_rename_whose_note_file_will_not_write_still_lands() {
    use std::os::unix::fs::PermissionsExt;

    let rel = "Locked/Plan.md";
    let f = opened(rel, PLAN);
    let garden = f.project("Garden");
    assert!(f.link(&garden).0.success);
    let folder = f.open.path.join("Locked");
    let set_mode = |mode| std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(mode));
    set_mode(0o555).unwrap();

    let rename = input(json!({ "id": garden, "name": "Orchard" }));
    let (renamed, events) = f.finish(f.tasks.update_project(rename).unwrap());
    set_mode(0o755).unwrap();

    assert!(renamed.success, "{renamed:?}");
    assert_eq!(renamed.project.unwrap().project.name, "Orchard");
    assert_eq!(events, [TaskEvent::ProjectUpdated(garden.clone())]);
    let text = f.e.read(rel);
    assert!(text.contains("Garden"), "the file was not written: {text}");
    assert_eq!(
        f.record_names(),
        Some(json!(["Garden"])),
        "the record follows its file"
    );
}
