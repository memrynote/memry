//! The project commands of `TasksService` over a real vault in a temp dir: Electron's refusal
//! keys with nothing queued, what a project delete does to its tasks, reorder positions, the
//! field clocks and outbox rows the sync push reads, the hub contents the vault can open, and the
//! events in `commands-projects.ts`'s order.

use memry_core::domain::note_files::NoteFileStat;
use memry_desktop::tasks::project_contract::{
    ProjectCreateInput, ProjectLinkItemInput, ProjectReorderInput, ProjectSetHomeNoteInput,
    ProjectSetLinkPinnedInput, ProjectUpdateInput,
};
use memry_desktop::tasks::service::TaskEvent;
use memry_desktop::tasks::write_contract::TaskCreateInput;
use memry_desktop::tasks::{
    INBOX_ARCHIVE, INBOX_DELETE, PROJECT_NOT_FOUND, PROJECT_REORDER_FAILED,
};
use serde_json::{Value, json};

use crate::device_key;
use crate::tasks_service::Fixture;

fn input<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn link(project: &str, item_type: &str, item: &str) -> ProjectLinkItemInput {
    input(json!({ "projectId": project, "itemType": item_type, "itemId": item }))
}

impl Fixture {
    /// The project's stored sync payload.
    fn payload(&self, item_type: &str, id: &str) -> Value {
        let (kind, id) = (item_type.to_owned(), id.to_owned());
        self.vault
            .db_handle()
            .call_blocking(move |conn| {
                let raw: String = conn
                    .query_row(
                        "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                        [kind, id],
                        |row| row.get(0),
                    )
                    .unwrap();
                Ok(serde_json::from_str(&raw).unwrap())
            })
            .unwrap()
    }

    /// Every outbox row, as `(item_type, item_id, op)`.
    fn queued(&self) -> Vec<(String, String, String)> {
        self.vault
            .db_handle()
            .call_blocking(|conn| {
                let mut statement = conn
                    .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY rowid")
                    .unwrap();
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                    .unwrap();
                Ok(rows.map(Result::unwrap).collect())
            })
            .unwrap()
    }

    fn new_task(&self, project: &str, extra: Value) -> String {
        let mut value = json!({ "projectId": project, "title": "Plan" });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let written = self
            .service
            .create(input::<TaskCreateInput>(value))
            .unwrap();
        written.mutation.task.unwrap().task.id
    }

    fn inbox(&self) -> String {
        self.tasks.ensure_inbox().unwrap();
        "inbox".to_owned()
    }
}

#[test]
fn project_create_and_update_land_with_their_clocks_queued_and_announced() {
    let f = Fixture::new();
    f.pushed();

    let created = f
        .service
        .create_project(input::<ProjectCreateInput>(json!({
            "name": "Garden",
            "statuses": [
                { "name": "Ideas", "type": "todo", "order": 0 },
                { "name": "Planted", "color": "#22c55e", "type": "done", "order": 1 }
            ]
        })))
        .unwrap();
    let project = created.mutation.project.clone().unwrap();
    let id = project.project.id.clone();
    assert!(created.mutation.success);
    assert_eq!(project.project.color, "#6366f1");
    let names: Vec<_> = project.statuses.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Ideas", "Planted"]);
    assert_eq!(created.events, [TaskEvent::ProjectCreated(id.clone())]);
    assert_eq!(
        f.queued(),
        [("project".into(), id.clone(), "upsert".into())]
    );
    let clock_before = f.payload("project", &id)["fieldClocks"]["name"].clone();
    assert!(clock_before.is_object(), "{clock_before}");

    f.pushed();
    let updated = f
        .service
        .update_project(input::<ProjectUpdateInput>(json!({
            "id": id, "name": "Orchard", "description": null
        })))
        .unwrap();
    assert!(updated.mutation.success);
    assert_eq!(updated.mutation.project.unwrap().project.name, "Orchard");
    assert_eq!(updated.events, [TaskEvent::ProjectUpdated(id.clone())]);
    assert_eq!(
        f.queued(),
        [("project".into(), id.clone(), "upsert".into())]
    );
    let clock_after = f.payload("project", &id)["fieldClocks"]["name"].clone();
    assert_ne!(
        clock_after, clock_before,
        "a rename ticks the name's field clock"
    );

    let listed = f.service.projects().unwrap();
    let names: Vec<_> = listed
        .projects
        .iter()
        .map(|p| p.project.name.as_str())
        .collect();
    assert_eq!(names, ["Work", "Orchard"]);
    assert!(!listed.projects[1].project.created_at.is_empty());
    assert!(f.service.project(&id).unwrap().is_some());
}

#[test]
fn project_writes_refuse_with_electrons_messages_and_queue_nothing() {
    let f = Fixture::new();
    let inbox = f.inbox();
    f.pushed();

    let missing = "no-such-project";
    let refusals = [
        f.service
            .update_project(input(json!({ "id": missing, "name": "X" }))),
        f.service.archive_project(missing),
        f.service.archive_project(&inbox),
        f.service.delete_project(&inbox),
        f.service.link_project_item(link(missing, "file", "f1")),
        f.service.unlink_project_item(link(missing, "file", "f1")),
        f.service
            .set_project_link_pinned(input::<ProjectSetLinkPinnedInput>(
                json!({ "projectId": missing, "itemId": "f1", "pinned": true }),
            )),
        f.service
            .set_project_home_note(input::<ProjectSetHomeNoteInput>(
                json!({ "projectId": missing, "noteId": null }),
            )),
        f.service.reorder_projects(input::<ProjectReorderInput>(
            json!({ "projectIds": [f.project], "positions": [] }),
        )),
    ];
    let errors: Vec<_> = refusals
        .into_iter()
        .map(|written| {
            let written = written.unwrap();
            assert!(!written.mutation.success);
            assert!(written.events.is_empty(), "a refusal announces nothing");
            written.mutation.error.unwrap()
        })
        .collect();
    assert_eq!(
        errors,
        [
            PROJECT_NOT_FOUND,
            PROJECT_NOT_FOUND,
            INBOX_ARCHIVE,
            INBOX_DELETE,
            PROJECT_NOT_FOUND,
            PROJECT_NOT_FOUND,
            PROJECT_NOT_FOUND,
            PROJECT_NOT_FOUND,
            PROJECT_REORDER_FAILED,
        ]
    );
    assert!(f.queued().is_empty(), "{:?}", f.queued());
    assert!(
        f.service
            .project(&inbox)
            .unwrap()
            .unwrap()
            .project
            .archived_at
            .is_none()
    );

    let bad_type = f
        .service
        .link_project_item(link(&f.project, "canvas", "c1"));
    assert!(
        bad_type.is_err(),
        "an itemType outside the zod enum is rejected"
    );
}

#[test]
fn project_delete_tombstones_its_tasks_and_announces_each_after_the_project() {
    let f = Fixture::new();
    let parent = f.new_task(&f.project, json!({ "title": "Parent", "position": 0 }));
    let child = f.new_task(&f.project, json!({ "title": "Child", "parentId": parent }));
    let tagged = f.new_task(
        &f.project,
        json!({ "title": "Tagged", "tags": ["home"], "position": 1 }),
    );
    let done = f.new_task(&f.project, json!({ "title": "Done", "position": 2 }));
    f.service.complete(input(json!({ "id": done }))).unwrap();
    let other = f
        .service
        .create_project(input(json!({ "name": "Other" })))
        .unwrap()
        .mutation
        .project
        .unwrap()
        .project
        .id;
    let kept = f.new_task(&other, json!({ "title": "Kept" }));
    f.pushed();

    let written = f.service.delete_project(&f.project).unwrap();

    assert!(written.mutation.success);
    assert_eq!(
        written.events,
        [
            TaskEvent::ProjectDeleted(f.project.clone()),
            TaskEvent::Deleted(parent.clone()),
            TaskEvent::Deleted(tagged.clone()),
            TaskEvent::TagsChanged,
            TaskEvent::Deleted(done.clone()),
            TaskEvent::Deleted(child.clone()),
        ]
    );
    for task in [&parent, &child, &tagged, &done] {
        assert!(f.service.get(task).unwrap().is_none(), "{task} is gone");
    }
    assert!(f.service.get(&kept).unwrap().is_some());
    assert!(f.service.project(&f.project).unwrap().is_none());
    assert!(f.service.statuses(&f.project).unwrap().is_empty());
    let deletes: Vec<_> = f
        .queued()
        .into_iter()
        .filter(|(_, _, op)| op == "delete")
        .map(|(kind, id, _)| (kind, id))
        .collect();
    assert_eq!(
        deletes,
        [
            ("task".to_owned(), parent),
            ("task".to_owned(), tagged),
            ("task".to_owned(), done),
            ("task".to_owned(), child),
            ("project".to_owned(), f.project.clone()),
        ],
        "every task is tombstoned for sync before its project"
    );

    let gone = f.service.delete_project("no-such-project").unwrap();
    assert!(
        gone.mutation.success,
        "deleting a missing project succeeds, as Electron's"
    );
    assert_eq!(
        gone.events,
        [TaskEvent::ProjectDeleted("no-such-project".to_owned())]
    );
}

#[test]
fn project_reorder_writes_each_position_and_skips_an_unknown_id() {
    let f = Fixture::new();
    let second = f
        .service
        .create_project(input(json!({ "name": "Second" })))
        .unwrap()
        .mutation
        .project
        .unwrap()
        .project
        .id;
    f.pushed();

    let written = f
        .service
        .reorder_projects(input(json!({
            "projectIds": [second, "no-such-project", f.project],
            "positions": [0, 5, 7]
        })))
        .unwrap();

    assert!(written.mutation.success);
    assert_eq!(
        written.events,
        [
            TaskEvent::ProjectUpdated(second.clone()),
            TaskEvent::ProjectUpdated(f.project.clone()),
        ]
    );
    let positions: Vec<_> = f
        .service
        .projects()
        .unwrap()
        .projects
        .into_iter()
        .map(|p| (p.project.id, p.project.position))
        .collect();
    assert_eq!(positions, [(second.clone(), 0), (f.project.clone(), 7)]);
    assert_eq!(f.payload("project", &f.project)["position"], json!(7));
    let queued: Vec<_> = f.queued().into_iter().map(|(_, id, _)| id).collect();
    assert_eq!(queued, [second, f.project.clone()]);
}

#[test]
fn links_pins_and_the_home_note_reach_the_project_payload_and_announce_it() {
    let f = Fixture::new();
    f.pushed();
    let p = f.project.clone();

    let linked = f
        .service
        .link_project_item(link(&p, "calendar_event", "ev1"))
        .unwrap();
    assert_eq!(linked.events, [TaskEvent::ProjectUpdated(p.clone())]);
    let links = f.service.project_links(&p).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(
        (links[0].item_type.as_str(), links[0].item_id.as_str()),
        ("calendar_event", "ev1")
    );
    assert_eq!(f.queued(), [("project".into(), p.clone(), "upsert".into())]);

    let pinned = f
        .service
        .set_project_link_pinned(input(
            json!({ "projectId": p, "itemId": "ev1", "pinned": true }),
        ))
        .unwrap();
    assert!(pinned.mutation.success);
    assert_eq!(f.payload("project", &p)["links"][0]["pinned"], json!(1));
    let unknown = f
        .service
        .set_project_link_pinned(input(
            json!({ "projectId": p, "itemId": "nope", "pinned": true }),
        ))
        .unwrap();
    assert!(
        unknown.mutation.success,
        "pinning an unlinked item is Electron's no-op"
    );

    let home = f
        .service
        .set_project_home_note(input(json!({ "projectId": p, "noteId": "n1" })))
        .unwrap();
    assert_eq!(
        home.mutation
            .project
            .unwrap()
            .project
            .home_note_id
            .as_deref(),
        Some("n1")
    );
    assert_eq!(home.events, [TaskEvent::ProjectUpdated(p.clone())]);

    let unlinked = f
        .service
        .unlink_project_item(link(&p, "calendar_event", "ev1"))
        .unwrap();
    assert_eq!(unlinked.events, [TaskEvent::ProjectUpdated(p.clone())]);
    assert!(f.service.project_links(&p).unwrap().is_empty());
    assert!(
        f.service
            .project_links("no-such-project")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn project_contents_list_only_the_notes_whose_file_the_vault_can_open() {
    let f = Fixture::new();
    let store = device_key::with_device_key();
    let note = f
        .vault
        .notes_writer(store)
        .unwrap()
        .create("Plan".to_owned(), None)
        .unwrap();
    f.service
        .link_project_item(link(&f.project, "note", &note))
        .unwrap();
    let refs = f
        .service
        .projects_for_item(input(json!({ "itemType": "note", "itemId": note })))
        .unwrap();
    assert_eq!(
        refs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        [f.project.as_str()]
    );

    let unlisted = f
        .service
        .project_contents(&f.project, &f.vault, f.root())
        .unwrap();
    assert!(
        unlisted.notes.is_empty(),
        "a note the vault lists no file for is left out"
    );

    let path = "Plan.md".to_owned();
    f.vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: note.clone(),
            path: path.clone(),
            file_type: "markdown".to_owned(),
            mime_type: None,
            file_size: None,
            content_hash: None,
            file_hash: None,
            indexed_at: 0,
        })
        .unwrap();
    let gone = f
        .service
        .project_contents(&f.project, &f.vault, f.root())
        .unwrap();
    assert!(
        gone.notes.is_empty(),
        "a note whose file is gone is left out"
    );
    assert_eq!(gone.counts.notes, 0);

    std::fs::write(f.root().join(&path), "# Plan\n").unwrap();
    let listed = f
        .service
        .project_contents(&f.project, &f.vault, f.root())
        .unwrap();
    assert_eq!(
        listed
            .notes
            .iter()
            .map(|n| n.id.as_str())
            .collect::<Vec<_>>(),
        [note.as_str()]
    );
    assert_eq!(listed.counts.notes, 1);
}
