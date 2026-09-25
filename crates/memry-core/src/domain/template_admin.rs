//! Template list, duplicate, update and delete (spec 006 ST18), after desktop
//! `vault/templates.ts`.
//!
//! **Built-ins live in code on desktop** (`vault/built-in-templates.ts`) and
//! never sync, so they are ported here verbatim and are read-only: update and
//! delete refuse them, duplicate copies one into a synced template. A remote
//! template whose id collides with a built-in is ignored, as desktop's
//! `template-handler.ts` ignores it.
//!
//! Desktop templates have no folder field; the Paper "Folder" pill has no data
//! behind it (spec 006 §6).

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{edit, failed, insert_local, iso, next_clock, object};
use crate::domain::tasks::model::new_task_id;
use crate::domain::templates;
use crate::storage::repositories::Change;
use crate::sync::outbox;

pub struct BuiltIn {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub icon: &'static str,
    pub tags: &'static [&'static str],
    pub properties: &'static str,
    pub content: &'static str,
}

pub const BUILT_INS: &[BuiltIn] = &[
    BuiltIn {
        id: "blank",
        name: "Blank Note",
        description: "Start with an empty note",
        icon: "📄",
        tags: &[],
        properties: "[]",
        content: "",
    },
    BuiltIn {
        id: "meeting-notes",
        name: "Meeting Notes",
        description: "Meeting agenda and notes template",
        icon: "📝",
        tags: &["meeting"],
        properties: r#"[{"name":"date","type":"date","value":null},{"name":"attendees","type":"text","value":""},{"name":"status","type":"select","value":"scheduled","options":["scheduled","completed","cancelled"]}]"#,
        content: "## Attendees\n\n-\n\n## Agenda\n\n1.\n2.\n3.\n\n## Notes\n\n## Action Items\n\n- [ ]\n",
    },
    BuiltIn {
        id: "project-brief",
        name: "Project Brief",
        description: "Template for project documentation",
        icon: "📋",
        tags: &["project"],
        properties: r#"[{"name":"status","type":"select","value":"planning","options":["planning","active","on-hold","completed"]},{"name":"priority","type":"rating","value":3},{"name":"startDate","type":"date","value":null},{"name":"dueDate","type":"date","value":null}]"#,
        content: "## Overview\n\nBrief description of the project...\n\n## Goals\n\n-\n-\n\n## Scope\n\n### In Scope\n\n-\n\n### Out of Scope\n\n-\n\n## Timeline\n\n## Notes\n\n",
    },
    BuiltIn {
        id: "daily-standup",
        name: "Daily Standup",
        description: "Daily standup format",
        icon: "✅",
        tags: &["standup", "daily"],
        properties: r#"[{"name":"date","type":"date","value":null}]"#,
        content: "## What I did yesterday\n\n-\n\n## What I'm doing today\n\n-\n\n## Blockers\n\n-\n",
    },
    BuiltIn {
        id: "morning-pages",
        name: "Morning Pages",
        description: "Stream of consciousness writing to start your day",
        icon: "🌅",
        tags: &["morning", "reflection"],
        properties: r#"[{"name":"mood","type":"select","value":"neutral","options":["great","good","neutral","low","difficult"]}]"#,
        content: "# Morning Pages\n\nWrite freely for the next few minutes. Don't worry about grammar, spelling, or making sense. Just let your thoughts flow...\n\n---\n\n",
    },
    BuiltIn {
        id: "daily-reflection",
        name: "Daily Reflection",
        description: "End-of-day reflection and gratitude",
        icon: "🌆",
        tags: &["reflection", "gratitude"],
        properties: r#"[{"name":"mood","type":"select","value":"neutral","options":["great","good","neutral","low","difficult"]},{"name":"energy","type":"rating","value":3}]"#,
        content: "# Daily Reflection\n\n## What went well today?\n\n-\n\n## What could have gone better?\n\n-\n\n## What am I grateful for?\n\n1.\n2.\n3.\n\n## What did I learn?\n\n",
    },
    BuiltIn {
        id: "gratitude-journal",
        name: "Gratitude Journal",
        description: "Focus on what you appreciate",
        icon: "🙏",
        tags: &["gratitude"],
        properties: "[]",
        content: "# Gratitude\n\nToday I am grateful for:\n\n1.\n2.\n3.\n4.\n5.\n\n---\n\n*One moment that made me smile:*\n\n",
    },
    BuiltIn {
        id: "weekly-review",
        name: "Weekly Review",
        description: "Reflect on your week and plan ahead",
        icon: "📅",
        tags: &["weekly", "review", "planning"],
        properties: r#"[{"name":"weekNumber","type":"number","value":0}]"#,
        content: "# Weekly Review\n\n## Wins This Week\n\n-\n\n## Challenges Faced\n\n-\n\n## Lessons Learned\n\n-\n\n## Next Week's Focus\n\n1.\n2.\n3.\n\n## Energy & Wellbeing Check\n\nHow do I feel about this week overall?\n\n",
    },
];

pub fn is_built_in(id: &str) -> bool {
    BUILT_INS.iter().any(|b| b.id == id)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    pub content: String,
    pub is_built_in: bool,
    /// ISO-8601, `None` for built-ins.
    pub modified_at: Option<String>,
}

/// The editable fields. `None` leaves a field as it is; `Some(None)` on the
/// optional ones clears it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TemplateEdit {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub icon: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
    pub content: Option<String>,
}

fn refuse(what: String) -> StorageError {
    StorageError::Invalid { what }
}

fn from_built_in(b: &BuiltIn) -> TemplateSummary {
    TemplateSummary {
        id: b.id.into(),
        name: b.name.into(),
        description: Some(b.description.into()),
        icon: Some(b.icon.into()),
        tags: b.tags.iter().map(|t| (*t).to_owned()).collect(),
        content: b.content.into(),
        is_built_in: true,
        modified_at: None,
    }
}

fn from_payload(id: String, payload: &Value) -> TemplateSummary {
    let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_owned);
    TemplateSummary {
        name: text("name").unwrap_or_default(),
        description: text("description"),
        icon: text("icon"),
        tags: payload
            .get("tags")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        content: text("content").unwrap_or_default(),
        is_built_in: false,
        modified_at: text("modifiedAt"),
        id,
    }
}

/// Built-ins first (desktop order), then the vault's own, newest first.
pub fn list(conn: &Connection) -> Result<Vec<TemplateSummary>, StorageError> {
    let mut out: Vec<TemplateSummary> = BUILT_INS.iter().map(from_built_in).collect();
    let mut statement = conn
        .prepare(
            "SELECT item_id, payload FROM sync_items
              WHERE item_type = ?1 AND deleted_at IS NULL AND payload IS NOT NULL",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![templates::ITEM_TYPE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?;
    let mut mine = Vec::new();
    for row in rows {
        let (id, raw) = row.map_err(failed)?;
        if is_built_in(&id) {
            continue;
        }
        if let Ok(payload) = serde_json::from_str::<Value>(&raw) {
            mine.push(from_payload(id, &payload));
        }
    }
    mine.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out.extend(mine);
    Ok(out)
}

fn source_payload(conn: &Connection, id: &str) -> Result<Value, StorageError> {
    if let Some(b) = BUILT_INS.iter().find(|b| b.id == id) {
        return Ok(json!({
            "name": b.name, "description": b.description, "icon": b.icon,
            "tags": b.tags, "properties": serde_json::from_str::<Value>(b.properties).unwrap_or(json!([])),
            "content": b.content,
        }));
    }
    let stored = crate::domain::notes::require_payload(conn, templates::ITEM_TYPE, id)?;
    Ok(Value::Object(stored.object().clone()))
}

/// Copies any template (built-in included) into a new one named `name`.
/// Returns the new id.
pub fn duplicate(
    conn: &Connection,
    id: &str,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(refuse("a template needs a name".into()));
    }
    let source = source_payload(conn, id)?;
    let new_id = new_task_id();
    let at = iso(now_ms)?;
    let payload = object(json!({
        "name": name,
        "description": source.get("description").cloned().unwrap_or(Value::Null),
        "icon": source.get("icon").cloned().unwrap_or(Value::Null),
        "tags": source.get("tags").cloned().unwrap_or(json!([])),
        "properties": source.get("properties").cloned().unwrap_or(json!([])),
        "content": source.get("content").cloned().unwrap_or(json!("")),
        "clock": next_clock(&Default::default(), device_id)?,
        "createdAt": at,
        "modifiedAt": at,
    }));
    outbox::commit(
        conn,
        &outbox::Change::upsert(templates::ITEM_TYPE, &new_id),
        now_ms,
        |tx| insert_local(tx, templates::ITEM_TYPE, &new_id, payload, now_ms),
    )?
    .acknowledge();
    Ok(new_id)
}

/// Saves the editor. Built-ins are refused.
pub fn update(
    conn: &Connection,
    id: &str,
    change: &TemplateEdit,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if is_built_in(id) {
        return Err(refuse(format!(
            "built-in template `{id}` cannot be modified"
        )));
    }
    let mut changes: Vec<(&'static str, Change)> = Vec::new();
    if let Some(name) = &change.name {
        let name = name.trim();
        if name.is_empty() {
            return Err(refuse("a template needs a name".into()));
        }
        changes.push(("name", Change::set(name)));
    }
    if let Some(description) = &change.description {
        changes.push((
            "description",
            Change::Set(description.clone().map(Value::from).unwrap_or(Value::Null)),
        ));
    }
    if let Some(icon) = &change.icon {
        changes.push((
            "icon",
            Change::Set(icon.clone().map(Value::from).unwrap_or(Value::Null)),
        ));
    }
    if let Some(tags) = &change.tags {
        changes.push((
            "tags",
            Change::set(crate::domain::tags::dedupe(tags.clone())),
        ));
    }
    if let Some(content) = &change.content {
        changes.push(("content", Change::set(content.clone())));
    }
    if changes.is_empty() {
        return Ok(());
    }
    edit(conn, templates::ITEM_TYPE, id, changes, device_id, now_ms)?.acknowledge();
    Ok(())
}

/// Tombstones a template. Built-ins are refused; notes made from it stay.
pub fn delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if is_built_in(id) {
        return Err(refuse(format!(
            "built-in template `{id}` cannot be deleted"
        )));
    }
    templates::delete(conn, id, device_id, now_ms)?.acknowledge();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Db, open_data, test_support::temp_dir};

    const NOW: i64 = 1_760_000_000_000;

    fn vault(label: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        (open_data(&dir.path().join("data.db")).expect("open"), dir)
    }

    #[test]
    fn built_ins_are_listed_first_and_are_read_only() {
        let (db, _d) = vault("tpl-builtin");
        db.call_blocking(|c| {
            let all = list(c)?;
            assert_eq!(all.len(), BUILT_INS.len());
            assert!(all.iter().all(|t| t.is_built_in));
            assert!(
                update(
                    c,
                    "blank",
                    &TemplateEdit {
                        name: Some("x".into()),
                        ..Default::default()
                    },
                    "p",
                    NOW
                )
                .is_err()
            );
            assert!(delete(c, "weekly-review", "p", NOW).is_err());
            Ok(())
        })
        .expect("builtins");
    }

    #[test]
    fn duplicate_update_delete_round_trip() {
        let (db, _d) = vault("tpl-crud");
        db.call_blocking(|c| {
            let id = duplicate(c, "weekly-review", "Agent Test Weekly", "p", NOW)?;
            let copy = list(c)?.into_iter().find(|t| t.id == id).expect("copy");
            assert!(!copy.is_built_in);
            assert_eq!(copy.tags, vec!["weekly", "review", "planning"]);
            assert!(copy.content.starts_with("# Weekly Review"));
            let props = crate::domain::notes::require_payload(c, templates::ITEM_TYPE, &id)?;
            assert_eq!(props.object()["properties"][0]["name"], json!("weekNumber"));

            update(
                c,
                &id,
                &TemplateEdit {
                    name: Some("Agent Test Renamed".into()),
                    icon: Some(None),
                    tags: Some(vec!["a".into(), "A".into()]),
                    content: Some("body".into()),
                    ..Default::default()
                },
                "p",
                NOW + 1,
            )?;
            let edited = list(c)?.into_iter().find(|t| t.id == id).expect("edited");
            assert_eq!(
                (
                    edited.name.as_str(),
                    edited.icon.clone(),
                    edited.tags.clone(),
                    edited.content.as_str()
                ),
                ("Agent Test Renamed", None, vec!["a".to_owned()], "body")
            );

            delete(c, &id, "p", NOW + 2)?;
            assert!(list(c)?.iter().all(|t| t.id != id));
            assert!(duplicate(c, "blank", "  ", "p", NOW).is_err());
            Ok(())
        })
        .expect("crud");
    }
}
