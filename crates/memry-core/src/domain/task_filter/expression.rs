//! The advanced filter: rules combined in `all` / `any` / `none` groups
//! (`packages/domain-tasks/src/filtering/expression.ts`, §13.7.14).
//!
//! The tree is read straight from JSON, because it syncs between builds: a
//! rule with a field or operator this build does not know, or with no usable
//! value, is skipped (`None`) and drops out of its group. A group with an
//! unknown `match` or nothing left to evaluate is skipped the same way, and a
//! fully skipped root passes every task. Each rule runs the dimension filter
//! its chip runs, over the one task.

use std::collections::HashMap;

use serde_json::Value;

use super::config::{DueDateFilter, DueDateKind, HasTimeFilter, RepeatFilter};
use super::filters::{
    filter_by_due_date_range, filter_by_has_time, filter_by_location, filter_by_priorities,
    filter_by_projects, filter_by_repeat_type, filter_by_statuses, filter_by_tags, js_trim,
};
use super::{FilterTask, Priority, TaskNoteInfo};
use crate::domain::calendar::{CivilDate, LocalDateTime};

/// What a rule reads besides the task.
#[derive(Debug, Clone, Copy)]
pub struct ExpressionContext<'a> {
    pub now: LocalDateTime,
    /// 0 Sunday, 1 Monday.
    pub week_starts_on: u32,
    /// Needed for a `location` rule to match anything.
    pub note_index: Option<&'a HashMap<String, TaskNoteInfo>>,
}

const GROUP_MATCHES: [&str; 3] = ["all", "any", "none"];
const DUE_PRESETS: [&str; 7] = [
    "none",
    "overdue",
    "today",
    "tomorrow",
    "this-week",
    "next-week",
    "this-month",
];

/// `matchesTaskFilterExpression`.
pub fn matches_expression(task: &FilterTask, expression: &Value, ctx: &ExpressionContext) -> bool {
    evaluate_group(task, expression, ctx).unwrap_or(true)
}

/// `countTaskFilterRules`: the rules this build evaluates, at any depth,
/// inside groups it evaluates.
pub fn count_rules(expression: Option<&Value>) -> u32 {
    let probe = FilterTask {
        id: String::new(),
        title: String::new(),
        description: None,
        project_id: String::new(),
        status_id: String::new(),
        parent_id: None,
        priority: Priority::None,
        due_date: None,
        due_time: None,
        created_at: LocalDateTime::from_ms(0),
        completed_at: None,
        archived_at: None,
        is_repeating: false,
        tags: Vec::new(),
        source_note_id: None,
        linked_note_ids: Vec::new(),
    };
    let ctx = ExpressionContext {
        now: LocalDateTime::from_ms(0),
        week_starts_on: 0,
        note_index: None,
    };
    fn visit(group: &Value, probe: &FilterTask, ctx: &ExpressionContext) -> u32 {
        if !is_known_match(group) {
            return 0;
        }
        nodes(group)
            .iter()
            .map(|node| {
                if is_group(node) {
                    visit(node, probe, ctx)
                } else {
                    u32::from(evaluate_rule(probe, node, ctx).is_some())
                }
            })
            .sum()
    }
    expression.map_or(0, |group| visit(group, &probe, &ctx))
}

/// `evaluateTaskFilterGroup`.
fn evaluate_group(task: &FilterTask, group: &Value, ctx: &ExpressionContext) -> Option<bool> {
    if !is_known_match(group) {
        return None;
    }
    let results: Vec<bool> = nodes(group)
        .iter()
        .filter_map(|node| {
            if is_group(node) {
                evaluate_group(task, node, ctx)
            } else {
                evaluate_rule(task, node, ctx)
            }
        })
        .collect();
    if results.is_empty() {
        return None;
    }
    Some(match group["match"].as_str() {
        Some("all") => results.iter().all(|hit| *hit),
        Some("any") => results.iter().any(|hit| *hit),
        _ => !results.iter().any(|hit| *hit),
    })
}

/// `evaluateTaskFilterRule`: `Some` for a rule this build evaluates, `None`
/// for one it skips.
fn evaluate_rule(task: &FilterTask, rule: &Value, ctx: &ExpressionContext) -> Option<bool> {
    let op = rule["op"].as_str().unwrap_or_default();
    let values = strings(&rule["values"]);
    let kept = |filtered: Vec<&FilterTask>| filtered.len() == 1;
    let one = [task];
    match rule["field"].as_str()? {
        "title" => {
            let query = values.first().map(|v| js_trim(v).to_lowercase())?;
            if query.is_empty() {
                return None;
            }
            with_op(
                op,
                "contains",
                "notContains",
                task.title.to_lowercase().contains(&query),
            )
        }
        "priority" if !values.is_empty() => {
            with_op(op, "any", "none", kept(filter_by_priorities(&one, &values)))
        }
        "status" if !values.is_empty() => {
            with_op(op, "any", "none", kept(filter_by_statuses(&one, &values)))
        }
        "project" if !values.is_empty() => {
            with_op(op, "any", "none", kept(filter_by_projects(&one, &values)))
        }
        "tags" => match op {
            "empty" => Some(task.tags.is_empty()),
            "notEmpty" => Some(!task.tags.is_empty()),
            _ if values.is_empty() => None,
            "all" => Some(
                values
                    .iter()
                    .all(|tag| kept(filter_by_tags(&one, std::slice::from_ref(tag)))),
            ),
            _ => with_op(op, "any", "none", kept(filter_by_tags(&one, &values))),
        },
        "due" => with_op(op, "is", "isNot", matches_due(task, rule, &values, ctx)?),
        "location" => {
            let folder_paths = strings(&rule["folderPaths"]);
            let note_ids = strings(&rule["noteIds"]);
            if folder_paths.is_empty() && note_ids.is_empty() {
                return None;
            }
            let hit = kept(filter_by_location(
                &one,
                &folder_paths,
                &note_ids,
                ctx.note_index,
            ));
            with_op(op, "any", "none", hit)
        }
        "repeat" if op == "is" => match values.first().map(String::as_str) {
            Some(value @ ("repeating" | "one-time")) => Some(kept(filter_by_repeat_type(
                &one,
                &RepeatFilter::from_name(value),
            ))),
            _ => None,
        },
        "hasTime" if op == "is" => match values.first().map(String::as_str) {
            Some(value @ ("with-time" | "without-time")) => Some(kept(filter_by_has_time(
                &one,
                &HasTimeFilter::from_name(value),
            ))),
            _ => None,
        },
        _ => None,
    }
}

/// Any of the rule's due values matches; `None` when none is usable.
fn matches_due(
    task: &FilterTask,
    rule: &Value,
    values: &[String],
    ctx: &ExpressionContext,
) -> Option<bool> {
    let custom = match (rule["dueStart"].as_str(), rule["dueEnd"].as_str()) {
        (Some(start), Some(end)) => js_date_key(start).zip(js_date_key(end)),
        _ => None,
    };
    let mut usable = false;
    let mut hit = false;
    for value in values {
        let matched = if DUE_PRESETS.contains(&value.as_str()) {
            let filter = DueDateFilter {
                kind: DueDateKind::from_name(value),
                ..DueDateFilter::default()
            };
            filter_by_due_date_range(&[task], &filter, ctx.now, ctx.week_starts_on).len() == 1
        } else if let ("custom", Some((start, end))) = (value.as_str(), custom) {
            task.due_date
                .is_some_and(|due| due.ms() >= start.start_ms() && due.ms() <= end.end_ms())
        } else {
            continue;
        };
        usable = true;
        hit |= matched;
    }
    usable.then_some(hit)
}

/// `/^\d{4}-\d{2}-\d{2}$/` then `parseDateKey` (`new Date(y, m - 1, d)`,
/// which rolls an out-of-range month or day over).
fn js_date_key(text: &str) -> Option<CivilDate> {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    if !shaped {
        return None;
    }
    let part = |range: std::ops::Range<usize>| text[range].parse::<i64>().ok();
    Some(CivilDate::from_js_parts(
        part(0..4)?,
        part(5..7)? - 1,
        part(8..10)?,
    ))
}

/// Applies `op` to a positive match; an unknown operator skips the rule.
fn with_op(op: &str, positive: &str, negative: &str, hit: bool) -> Option<bool> {
    if op == positive {
        Some(hit)
    } else if op == negative {
        Some(!hit)
    } else {
        None
    }
}

/// `'match' in node`.
fn is_group(node: &Value) -> bool {
    node.get("match").is_some()
}

fn is_known_match(group: &Value) -> bool {
    group["match"]
        .as_str()
        .is_some_and(|name| GROUP_MATCHES.contains(&name))
}

fn nodes(group: &Value) -> &[Value] {
    group["rules"].as_array().map_or(&[], Vec::as_slice)
}

/// The string elements of an array; anything else is empty.
fn strings(list: &Value) -> Vec<String> {
    list.as_array().map_or_else(Vec::new, |items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}
