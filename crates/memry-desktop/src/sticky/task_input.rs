//! `stickies/task-input.ts`: sticky text as a new task. The first line goes through the quick-add
//! grammar (`@date`, `!priority`, `+project`, `#tag`, `every ...`); the rest is the description.

use memry_core::api::task_records::RepeatRule;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::task_parse::quick_add::{QuickAddProject, parse_quick_add};

use super::text::{cut_utf16, split};

/// UTF-16 units, as `TaskCreateSchema` counts them.
const TITLE_LIMIT: usize = 500;
const TAG_LIMIT: usize = 20;

/// The projects a sticky task can land in.
pub struct TaskContext<'a> {
    /// The live (unarchived) projects, which `+name` matches.
    pub projects: &'a [QuickAddProject],
    /// The user's default project, when it is still one of `projects`.
    pub default_project_id: Option<&'a str>,
    pub inbox_project_id: &'a str,
    pub now: LocalDateTime,
}

pub fn task_input(text: &str, context: &TaskContext<'_>) -> NewTaskInput {
    let (first_line, rest) = split(text);
    let parsed = parse_quick_add(first_line, context.projects, context.now);
    let title = match parsed.title.trim() {
        // A line made only of syntax (`@tomorrow`) still needs a title.
        "" => first_line,
        title => title,
    };
    NewTaskInput {
        title: cut_utf16(title, TITLE_LIMIT).to_owned(),
        project_id: parsed
            .project_id
            .or_else(|| context.default_project_id.map(str::to_owned))
            .unwrap_or_else(|| context.inbox_project_id.to_owned()),
        status_id: None,
        parent_id: None,
        priority: parsed.priority.to_wire(),
        description: (!rest.is_empty()).then(|| rest.to_owned()),
        due_date: parsed.due_date.map(|date| date.key()),
        due_time: parsed.due_time,
        start_date: None,
        repeat: parsed.repeat.map(RepeatRule::from),
        repeat_from: None,
        tags: parsed.tags.into_iter().take(TAG_LIMIT).collect(),
        linked_note_ids: Vec::new(),
        linked_canvas_ids: Vec::new(),
        source_note_id: None,
        position: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, name: &str) -> QuickAddProject {
        QuickAddProject {
            id: id.to_owned(),
            name: name.to_owned(),
            is_archived: false,
        }
    }

    fn context<'a>(projects: &'a [QuickAddProject], default: Option<&'a str>) -> TaskContext<'a> {
        TaskContext {
            projects,
            default_project_id: default,
            inbox_project_id: "inbox",
            now: LocalDateTime::parse("2025-03-10T09:30:00").unwrap(),
        }
    }

    #[test]
    fn the_first_line_is_parsed_and_the_rest_is_the_description() {
        let projects = [project("p-work", "Work")];
        let input = task_input(
            "Call Ana @tomorrow !high +work #calls\nabout the lease",
            &context(&projects, None),
        );
        assert_eq!(input.title, "Call Ana");
        assert_eq!(input.project_id, "p-work");
        assert_eq!(input.priority, 3);
        assert_eq!(input.due_date.as_deref(), Some("2025-03-11"));
        assert_eq!(input.tags, vec!["calls".to_owned()]);
        assert_eq!(input.description.as_deref(), Some("about the lease"));
        assert!(input.repeat.is_none());
    }

    #[test]
    fn a_task_with_no_project_goes_to_the_default_then_the_inbox() {
        let projects = [project("p-home", "Home")];
        assert_eq!(
            task_input("Milk", &context(&projects, Some("p-home"))).project_id,
            "p-home"
        );
        let input = task_input("Milk", &context(&projects, None));
        assert_eq!(input.project_id, "inbox");
        assert_eq!(input.description, None);
    }

    #[test]
    fn a_line_of_only_syntax_keeps_the_line_as_the_title() {
        let input = task_input("@tomorrow", &context(&[], None));
        assert_eq!(input.title, "@tomorrow");
        assert_eq!(input.due_date.as_deref(), Some("2025-03-11"));
    }

    #[test]
    fn a_repeat_phrase_makes_a_repeating_task() {
        let input = task_input("Water plants every monday", &context(&[], None));
        assert_eq!(input.title, "Water plants");
        assert_eq!(
            input.repeat.map(|rule| rule.frequency).as_deref(),
            Some("weekly")
        );
    }

    #[test]
    fn the_title_and_tags_are_capped() {
        let tags: String = (0..25).map(|n| format!(" #t{n}")).collect();
        // 300 emoji are 600 UTF-16 units: 250 of them fill the 500.
        let input = task_input(
            &format!("{}{tags}", "\u{1F600}".repeat(300)),
            &context(&[], None),
        );
        assert_eq!(input.title.encode_utf16().count(), 500);
        assert_eq!(input.title.chars().count(), 250);
        assert_eq!(input.tags.len(), 20);
    }
}
