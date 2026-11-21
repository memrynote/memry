//! The zod refinements (`.refine`) of the tool inputs, which Electron's JSON Schemas cannot carry:
//! real calendar dates on tasks, http(s)-only canvas links (Electron's guard against `file:` and
//! `javascript:` links in agent-drawn canvases), one endpoint form per arrow end, and a bulk tag
//! call that adds or removes something. `tools.json` lists them under `refinements`; the test
//! below holds this table to that list. The zod walk ([`super::zod`]) runs them as zod runs a
//! `.refine`: after the checks of the value at their path, unless one of those stopped the parse.

use serde_json::Value;

use super::zod::Seg;

const CALENDAR_DATE: &str = "Date must be a real calendar date in YYYY-MM-DD form";
const HTTP_LINK: &str = "link must be an http(s) URL";
const ONE_ENDPOINT: &str = "exactly one of ref or elementId is required";
const SOME_TAG: &str = "Give at least one tag in add or remove.";
const BINARY_DATA: &str =
    "Must be binary data (Buffer, Uint8Array, ArrayBuffer, or serialized buffer)";
const TASK_FIELDS: &str = "At most 100 fields";
const TASK_FIELD_KEYS: &str = "At most 50 keys";

/// The value at `path` (`[]` is every item of an array) satisfies `holds`, or the call is refused
/// with `message`.
pub(super) struct Refinement {
    tool: &'static str,
    path: &'static [&'static str],
    message: &'static str,
    holds: fn(&Value) -> bool,
}

const fn refinement(
    tool: &'static str,
    path: &'static [&'static str],
    message: &'static str,
    holds: fn(&Value) -> bool,
) -> Refinement {
    Refinement {
        tool,
        path,
        message,
        holds,
    }
}

const REFINEMENTS: &[Refinement] = &[
    refinement("vault_create_task", &["due"], CALENDAR_DATE, calendar_date),
    refinement(
        "vault_create_task",
        &["due_date"],
        CALENDAR_DATE,
        calendar_date,
    ),
    refinement(
        "vault_create_task",
        &["start_date"],
        CALENDAR_DATE,
        calendar_date,
    ),
    refinement("vault_update_task", &["due"], CALENDAR_DATE, calendar_date),
    refinement(
        "vault_update_task",
        &["due_date"],
        CALENDAR_DATE,
        calendar_date,
    ),
    refinement(
        "vault_update_task",
        &["start_date"],
        CALENDAR_DATE,
        calendar_date,
    ),
    refinement("vault_bulk_tag_notes", &[], SOME_TAG, some_tag),
    refinement(
        "vault_draw_on_canvas",
        &["elements", "[]", "link"],
        HTTP_LINK,
        http_link,
    ),
    refinement(
        "vault_draw_on_canvas",
        &["elements", "[]", "start"],
        ONE_ENDPOINT,
        one_endpoint,
    ),
    refinement(
        "vault_draw_on_canvas",
        &["elements", "[]", "end"],
        ONE_ENDPOINT,
        one_endpoint,
    ),
    refinement(
        "vault_draw_on_canvas",
        &["elements", "[]", "url"],
        HTTP_LINK,
        http_link,
    ),
    refinement(
        "vault_edit_canvas_elements",
        &["edits", "[]", "link"],
        HTTP_LINK,
        http_link,
    ),
];

/// The refinements of the desktop API arguments, by message: `desktop-ops.json` `checks` names
/// the schema node each applies to, and the test below holds this table to that list.
type Holds = fn(&Value) -> bool;

const DESKTOP_REFINEMENTS: &[(&str, Holds)] = &[
    (CALENDAR_DATE, calendar_date),
    (BINARY_DATA, binary_data),
    (TASK_FIELDS, |value| own_keys(value) <= 100),
    (TASK_FIELD_KEYS, |value| own_keys(value) <= 50),
];

/// The desktop API refinement whose message is `message`.
pub(super) fn desktop_refinement(message: &str) -> Option<Holds> {
    DESKTOP_REFINEMENTS
        .iter()
        .find(|(known, _)| *known == message)
        .map(|(_, holds)| *holds)
}

/// The refinements of `tool`.
pub(super) fn for_tool(tool: &str) -> Vec<&'static Refinement> {
    REFINEMENTS
        .iter()
        .filter(|refinement| refinement.tool == tool)
        .collect()
}

impl Refinement {
    /// The message, when `value` sits at this refinement's path and breaks it.
    pub(super) fn broken_by(&self, path: &[Seg], value: &Value) -> Option<&'static str> {
        let here = self.path.len() == path.len()
            && self.path.iter().zip(path).all(|(want, seg)| match seg {
                Seg::Index(_) => *want == "[]",
                Seg::Key(key) => want == key,
            });
        (here && !(self.holds)(value)).then_some(self.message)
    }
}

/// `isCalendarDate` (`packages/contracts/src/calendar-date.ts`): `^\d{4}-\d{2}-\d{2}$`, then a
/// round trip through a local `Date`. That constructor reads the years 0 to 99 as 1900 to 1999,
/// so the round trip refuses them.
fn calendar_date(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    if !shaped {
        return false;
    }
    let number = |from: usize, to: usize| -> u32 {
        bytes[from..to]
            .iter()
            .fold(0, |sum, digit| sum * 10 + u32::from(digit - b'0'))
    };
    let (year, month, day) = (number(0, 4), number(5, 7), number(8, 10));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year >= 100 && (1..=days).contains(&day)
}

/// `/^https?:\/\//i` of `canvas-draw.ts` `LinkSchema`.
fn http_link(value: &Value) -> bool {
    let bytes = value.as_str().unwrap_or_default().as_bytes();
    let starts = |scheme: &[u8]| {
        bytes
            .get(..scheme.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(scheme))
    };
    starts(b"http://") || starts(b"https://")
}

/// `Boolean(ref) !== Boolean(elementId)` of `canvas-draw.ts` `ArrowEndpointSchema`.
fn one_endpoint(value: &Value) -> bool {
    let truthy = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
    };
    truthy("ref") != truthy("elementId")
}

/// `binaryDataSchema` of `inbox-api.ts` over JSON: a non-empty object or array whose values are
/// all numbers (the IPC form of a buffer).
fn binary_data(value: &Value) -> bool {
    match value {
        Value::Array(items) => !items.is_empty() && items.iter().all(Value::is_number),
        Value::Object(object) => !object.is_empty() && object.values().all(Value::is_number),
        _ => false,
    }
}

/// `Object.keys(value).length` of `tasks-api.ts`'s field refinements, run on zod's record output,
/// which leaves out `__proto__`.
fn own_keys(value: &Value) -> usize {
    value.as_object().map_or(0, |object| {
        object.keys().filter(|key| *key != "__proto__").count()
    })
}

/// `(add?.length ?? 0) + (remove?.length ?? 0) > 0` of `note-action-schemas.ts`.
fn some_tag(value: &Value) -> bool {
    let count = |key: &str| value.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    count("add") + count("remove") > 0
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use std::collections::BTreeSet;

    use super::{DESKTOP_REFINEMENTS, REFINEMENTS};
    use crate::agent::mcp::desktop_args::DESKTOP_OPS_JSON;
    use crate::agent::mcp::schemas::TOOLS_JSON;

    /// A desktop refinement Electron adds or drops changes `desktop-ops.json`, and the table must
    /// follow: a listed one without a Rust check fails the catalogue load, an unlisted one here.
    #[test]
    fn the_desktop_table_is_electrons_list_of_refinements() {
        let file: Value = serde_json::from_str(DESKTOP_OPS_JSON).unwrap();
        let listed: BTreeSet<&str> = file["operations"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|operation| operation["checks"].as_array().unwrap())
            .filter(|check| check["check"] == "custom")
            .map(|check| check["message"].as_str().unwrap())
            .collect();
        let table: BTreeSet<&str> = DESKTOP_REFINEMENTS
            .iter()
            .map(|(message, _)| *message)
            .collect();
        assert_eq!(table, listed);
    }

    /// A refinement Electron adds or drops changes `tools.json`, and this table must follow.
    #[test]
    fn the_table_is_electrons_list_of_refinements() {
        let file: Value = serde_json::from_str(TOOLS_JSON).unwrap();
        let mut listed: Vec<(String, Vec<String>, String)> =
            serde_json::from_value::<Vec<Value>>(file["refinements"].clone())
                .unwrap()
                .into_iter()
                .map(|entry| {
                    serde_json::from_value(serde_json::json!([
                        entry["tool"],
                        entry["path"],
                        entry["message"]
                    ]))
                    .unwrap()
                })
                .collect();
        let mut table: Vec<(String, Vec<String>, String)> = REFINEMENTS
            .iter()
            .map(|refinement| {
                let path = refinement
                    .path
                    .iter()
                    .map(|segment| (*segment).to_owned())
                    .collect();
                (
                    refinement.tool.to_owned(),
                    path,
                    refinement.message.to_owned(),
                )
            })
            .collect();
        listed.sort();
        table.sort();
        assert_eq!(table, listed);
    }
}
