//! The filter dimensions, the sort, and the two together
//! (`packages/domain-tasks/src/filtering/filters.ts`).
//!
//! Each filter keeps the input order and returns the tasks that pass, as
//! references into the caller's rows. Date ranges compare local milliseconds
//! exactly as the TypeScript compares `getTime()`.

use std::cmp::Ordering;
use std::collections::HashSet;

use super::collation::locale_compare;
use super::config::{
    CompletionFilter, DueDateFilter, DueDateKind, HasTimeFilter, RepeatFilter, SortDirection,
    SortField, TaskFilters, TaskSort,
};
use super::{FilterProject, FilterTask, Priority, StatusType, find_status};
use crate::domain::calendar::{CivilDate, LocalDateTime};
use crate::domain::task_tree::{TaskTree, TreeNode};

/// `filterBySearch`: case-insensitive substring of the title or description.
/// A blank query keeps every task.
pub fn filter_by_search<'a>(tasks: &[&'a FilterTask], query: &str) -> Vec<&'a FilterTask> {
    if js_trim(query).is_empty() {
        return tasks.to_vec();
    }
    let lowered = query.to_lowercase();
    let needle = js_trim(&lowered);
    keep(tasks, |task| {
        task.title.to_lowercase().contains(needle)
            || task
                .description
                .as_deref()
                .is_some_and(|description| description.to_lowercase().contains(needle))
    })
}

/// `filterByProjects`. An empty selection keeps every task.
pub fn filter_by_projects<'a>(
    tasks: &[&'a FilterTask],
    project_ids: &[String],
) -> Vec<&'a FilterTask> {
    if project_ids.is_empty() {
        return tasks.to_vec();
    }
    keep(tasks, |task| project_ids.contains(&task.project_id))
}

/// `filterByPriorities` over priority names. An empty selection keeps every
/// task; a name this build does not know matches none.
pub fn filter_by_priorities<'a>(
    tasks: &[&'a FilterTask],
    priorities: &[String],
) -> Vec<&'a FilterTask> {
    if priorities.is_empty() {
        return tasks.to_vec();
    }
    keep(tasks, |task| {
        priorities.iter().any(|name| name == task.priority.name())
    })
}

/// `filterByTags`: any tag matches, case-insensitively.
pub fn filter_by_tags<'a>(tasks: &[&'a FilterTask], tags: &[String]) -> Vec<&'a FilterTask> {
    if tags.is_empty() {
        return tasks.to_vec();
    }
    let selected: HashSet<String> = tags.iter().map(|tag| tag.to_lowercase()).collect();
    keep(tasks, |task| {
        task.tags
            .iter()
            .any(|tag| selected.contains(&tag.to_lowercase()))
    })
}

/// `filterByDueDateRange`. `week_starts_on` is 0 (Sunday) or 1 (Monday).
///
/// `endOfWeek` and `endOfMonth` are the **start** of their last day in the
/// TypeScript, and `endOfMonth` on the 29th-31st rolls into the next month
/// (`setMonth` then `setDate(0)`); both are reproduced. An unknown type keeps
/// every task. A custom range with either end unset keeps every task; one
/// whose end does not parse keeps none (`new Date` gives an invalid date).
pub fn filter_by_due_date_range<'a>(
    tasks: &[&'a FilterTask],
    filter: &DueDateFilter,
    now: LocalDateTime,
    week_starts_on: u32,
) -> Vec<&'a FilterTask> {
    let today = now.date();
    let due_within = |start: i64, end: i64| {
        keep(tasks, |task| {
            task.due_date
                .is_some_and(|due| due.ms() >= start && due.ms() <= end)
        })
    };
    match &filter.kind {
        DueDateKind::Any | DueDateKind::Other(_) => tasks.to_vec(),
        DueDateKind::None => keep(tasks, |task| task.due_date.is_none()),
        DueDateKind::Overdue => keep(tasks, |task| {
            task.due_date.is_some_and(|due| due.date() < today) && task.completed_at.is_none()
        }),
        DueDateKind::Today => due_within(today.start_ms(), today.end_ms()),
        DueDateKind::Tomorrow => {
            let tomorrow = today.add_days(1);
            due_within(tomorrow.start_ms(), tomorrow.end_ms())
        }
        DueDateKind::ThisWeek => due_within(
            today.start_ms(),
            today.end_of_week(week_starts_on).start_ms(),
        ),
        DueDateKind::NextWeek => {
            let next_week = today.add_days(7);
            due_within(
                next_week.start_of_week(week_starts_on).start_ms(),
                next_week.end_of_week(week_starts_on).start_ms(),
            )
        }
        DueDateKind::ThisMonth => due_within(today.start_ms(), js_end_of_month(today).start_ms()),
        DueDateKind::Custom => {
            let start = filter
                .custom_start
                .as_deref()
                .filter(|text| !text.is_empty());
            let end = filter.custom_end.as_deref().filter(|text| !text.is_empty());
            let (Some(start), Some(end)) = (start, end) else {
                return tasks.to_vec();
            };
            let day = |text: &str| LocalDateTime::parse(text).map(LocalDateTime::date);
            match (day(start), day(end)) {
                (Some(start), Some(end)) => due_within(start.start_ms(), end.end_ms()),
                _ => Vec::new(),
            }
        }
    }
}

/// `filterByStatuses`. An empty selection keeps every task.
pub fn filter_by_statuses<'a>(
    tasks: &[&'a FilterTask],
    status_ids: &[String],
) -> Vec<&'a FilterTask> {
    if status_ids.is_empty() {
        return tasks.to_vec();
    }
    keep(tasks, |task| status_ids.contains(&task.status_id))
}

/// `filterByCompletion`. `archived` keeps only archived tasks; every other
/// value drops them first. Complete means the status resolves, inside the
/// task's own project, to a `done` status; an unknown value keeps all
/// non-archived tasks.
pub fn filter_by_completion<'a>(
    tasks: &[&'a FilterTask],
    completion: &CompletionFilter,
    projects: &[FilterProject],
) -> Vec<&'a FilterTask> {
    if *completion == CompletionFilter::Archived {
        return keep(tasks, |task| task.archived_at.is_some());
    }
    let is_complete = |task: &FilterTask| {
        find_status(projects, &task.project_id, &task.status_id)
            .is_some_and(|status| status.status_type == StatusType::Done)
    };
    keep(tasks, |task| {
        task.archived_at.is_none()
            && match completion {
                CompletionFilter::Active => !is_complete(task),
                CompletionFilter::Completed => is_complete(task),
                _ => true,
            }
    })
}

/// `filterByRepeatType`. An unknown value keeps every task.
pub fn filter_by_repeat_type<'a>(
    tasks: &[&'a FilterTask],
    repeat_type: &RepeatFilter,
) -> Vec<&'a FilterTask> {
    match repeat_type {
        RepeatFilter::Repeating => keep(tasks, |task| task.is_repeating),
        RepeatFilter::OneTime => keep(tasks, |task| !task.is_repeating),
        _ => tasks.to_vec(),
    }
}

/// `filterByHasTime`: whether `dueTime` is set at all (an empty string counts
/// as set, as `!== null` does). An unknown value keeps every task.
pub fn filter_by_has_time<'a>(
    tasks: &[&'a FilterTask],
    has_time: &HasTimeFilter,
) -> Vec<&'a FilterTask> {
    match has_time {
        HasTimeFilter::WithTime => keep(tasks, |task| task.due_time.is_some()),
        HasTimeFilter::WithoutTime => keep(tasks, |task| task.due_time.is_none()),
        _ => tasks.to_vec(),
    }
}

/// `sortTasksAdvanced`: a stable sort by one field. `folder` and `note` order
/// by due date (their group order is the grouping's business); an unknown
/// field leaves the order untouched.
pub fn sort_tasks_advanced<'a>(
    tasks: &[&'a FilterTask],
    sort: &TaskSort,
    projects: &[FilterProject],
) -> Vec<&'a FilterTask> {
    let mut sorted = tasks.to_vec();
    sorted.sort_by(|a, b| {
        let comparison = compare_by_field(a, b, &sort.field, projects);
        if sort.direction == SortDirection::Desc {
            comparison.reverse()
        } else {
            comparison
        }
    });
    sorted
}

fn apply_filter_chain<'a>(
    tasks: &[&'a FilterTask],
    filters: &TaskFilters,
    projects: &[FilterProject],
    now: LocalDateTime,
    week_starts_on: u32,
) -> Vec<&'a FilterTask> {
    let mut result = tasks.to_vec();
    if !filters.search.is_empty() {
        result = filter_by_search(&result, &filters.search);
    }
    result = filter_by_projects(&result, &filters.project_ids);
    result = filter_by_priorities(&result, &filters.priorities);
    result = filter_by_tags(&result, &filters.tags);
    result = filter_by_due_date_range(&result, &filters.due_date, now, week_starts_on);
    result = filter_by_statuses(&result, &filters.status_ids);
    result = filter_by_completion(&result, &filters.completion, projects);
    result = filter_by_repeat_type(&result, &filters.repeat_type);
    filter_by_has_time(&result, &filters.has_time)
}

/// `hasNarrowingFilter`: a filter that picks tasks by what they are, as
/// opposed to the completion and project scopes. Only these reach below the
/// top level.
fn has_narrowing_filter(filters: &TaskFilters) -> bool {
    !filters.search.trim().is_empty()
        || !filters.priorities.is_empty()
        || !filters.tags.is_empty()
        || filters.due_date.kind != DueDateKind::Any
        || !filters.status_ids.is_empty()
        || filters.repeat_type != RepeatFilter::All
        || filters.has_time != HasTimeFilter::All
}

impl TreeNode for FilterTask {
    fn node_id(&self) -> &str {
        &self.id
    }
    fn node_parent(&self) -> Option<&str> {
        self.parent_id.as_deref()
    }
}

/// `applyFiltersAndSortWithContext`: matching top-level tasks bring their
/// whole branch at any depth. With a narrowing filter, a deeper match also
/// shows with its branch, and its ancestors join as context (the second
/// value), which lists draw muted.
pub fn apply_filters_and_sort_with_context<'a>(
    tasks: &'a [FilterTask],
    filters: &TaskFilters,
    sort: &TaskSort,
    projects: &[FilterProject],
    now: LocalDateTime,
    week_starts_on: u32,
) -> (Vec<&'a FilterTask>, HashSet<&'a str>) {
    let tree = TaskTree::build(tasks);
    let roots: Vec<&FilterTask> = tasks.iter().filter(|t| tree.is_root(&t.id)).collect();
    let mut included: HashSet<&str> = HashSet::new();
    let mut context: HashSet<&str> = HashSet::new();
    let include_branch =
        |id: &'a str, included: &mut HashSet<&'a str>, context: &mut HashSet<&'a str>| {
            for each in std::iter::once(id).chain(tree.descendant_ids(id)) {
                included.insert(each);
                context.remove(each);
            }
        };

    for root in apply_filter_chain(&roots, filters, projects, now, week_starts_on) {
        include_branch(&root.id, &mut included, &mut context);
    }

    if has_narrowing_filter(filters) {
        let deeper: Vec<&FilterTask> = tasks
            .iter()
            .filter(|t| !tree.is_root(&t.id) && !included.contains(t.id.as_str()))
            .collect();
        for found in apply_filter_chain(&deeper, filters, projects, now, week_starts_on) {
            let id = found.id.as_str();
            if included.contains(id) && !context.contains(id) {
                continue;
            }
            let ancestors = tree.ancestor_ids(id);
            // Under a missing parent the task is in no tree, so it shows nowhere.
            if !ancestors.last().is_some_and(|top| tree.is_root(top)) {
                continue;
            }
            for ancestor in ancestors {
                if included.insert(ancestor) {
                    context.insert(ancestor);
                }
            }
            include_branch(id, &mut included, &mut context);
        }
    }

    // Roots first, then deeper rows, each in input order: the order the sort
    // breaks ties by.
    let ordered: Vec<&FilterTask> = roots
        .iter()
        .copied()
        .filter(|t| included.contains(t.id.as_str()))
        .chain(
            tasks
                .iter()
                .filter(|t| !tree.is_root(&t.id) && included.contains(t.id.as_str())),
        )
        .collect();
    (sort_tasks_advanced(&ordered, sort, projects), context)
}

/// `applyFiltersAndSort`: [`apply_filters_and_sort_with_context`] without the
/// context ids.
pub fn apply_filters_and_sort<'a>(
    tasks: &'a [FilterTask],
    filters: &TaskFilters,
    sort: &TaskSort,
    projects: &[FilterProject],
    now: LocalDateTime,
    week_starts_on: u32,
) -> Vec<&'a FilterTask> {
    apply_filters_and_sort_with_context(tasks, filters, sort, projects, now, week_starts_on).0
}

/// `hasActiveFilters`: anything differs from the default filter.
pub fn has_active_filters(filters: &TaskFilters) -> bool {
    count_active_filters(filters) > 0
}

/// `countActiveFilters`: how many dimensions differ from the default.
pub fn count_active_filters(filters: &TaskFilters) -> u32 {
    [
        !filters.search.is_empty(),
        !filters.project_ids.is_empty(),
        !filters.priorities.is_empty(),
        !filters.tags.is_empty(),
        filters.due_date.kind != DueDateKind::Any,
        !filters.status_ids.is_empty(),
        filters.completion != CompletionFilter::Active,
        filters.repeat_type != RepeatFilter::All,
        filters.has_time != HasTimeFilter::All,
    ]
    .into_iter()
    .map(u32::from)
    .sum()
}

fn compare_by_field(
    a: &FilterTask,
    b: &FilterTask,
    field: &SortField,
    projects: &[FilterProject],
) -> Ordering {
    match field {
        SortField::DueDate | SortField::Folder | SortField::Note => {
            compare_nullable(a.due_date, b.due_date, Ord::cmp).then_with(|| {
                if a.due_date.is_none() || b.due_date.is_none() {
                    return Ordering::Equal;
                }
                // `compareNullable` tests truthiness: an empty time is missing.
                let time = |task: &FilterTask| task.due_time.clone().filter(|t| !t.is_empty());
                compare_nullable(time(a), time(b), |x, y| locale_compare(x, y))
            })
        }
        SortField::Priority => priority_rank(a.priority).cmp(&priority_rank(b.priority)),
        SortField::CreatedAt => a.created_at.cmp(&b.created_at),
        SortField::Title => locale_compare(&a.title, &b.title),
        SortField::Status => status_rank(a, projects).cmp(&status_rank(b, projects)),
        SortField::Project => locale_compare(project_name(a, projects), project_name(b, projects)),
        SortField::CompletedAt => compare_nullable(a.completed_at, b.completed_at, Ord::cmp),
        SortField::Other(_) => Ordering::Equal,
    }
}

/// `compareNullable`: a missing value sorts after any present one.
fn compare_nullable<T>(
    a: Option<T>,
    b: Option<T>,
    compare: impl Fn(&T, &T) -> Ordering,
) -> Ordering {
    match (&a, &b) {
        (Some(x), Some(y)) => compare(x, y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn priority_rank(priority: Priority) -> u8 {
    match priority {
        Priority::Urgent => 0,
        Priority::High => 1,
        Priority::Medium => 2,
        Priority::Low => 3,
        Priority::None => 4,
    }
}

/// `statusTypeOrder[type] * 100 + order`, or 99 for an unresolved status.
fn status_rank(task: &FilterTask, projects: &[FilterProject]) -> i64 {
    find_status(projects, &task.project_id, &task.status_id).map_or(99, |status| {
        let type_rank = match status.status_type {
            StatusType::Todo => 0,
            StatusType::InProgress => 1,
            StatusType::Done => 2,
        };
        type_rank * 100 + status.order
    })
}

/// `projects.find(...)?.name || ''`.
fn project_name<'a>(task: &FilterTask, projects: &'a [FilterProject]) -> &'a str {
    projects
        .iter()
        .find(|project| project.id == task.project_id)
        .map_or("", |project| project.name.as_str())
}

/// `endOfMonth`: `setMonth(getMonth() + 1)` (rolling over a short month), then
/// `setDate(0)`.
fn js_end_of_month(date: CivilDate) -> CivilDate {
    let next = date.add_months(1);
    CivilDate::from_js_parts(next.year, i64::from(next.month) - 1, 0)
}

/// `String.prototype.trim`: Unicode white space and line terminators plus
/// U+FEFF, but not U+0085 (which Rust's `trim` removes).
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

fn keep<'a>(
    tasks: &[&'a FilterTask],
    predicate: impl Fn(&FilterTask) -> bool,
) -> Vec<&'a FilterTask> {
    tasks
        .iter()
        .copied()
        .filter(|task| predicate(task))
        .collect()
}
