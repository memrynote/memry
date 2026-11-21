//! The zod refinements (`.refine`) of the tool inputs, which Electron's JSON Schemas cannot carry:
//! real calendar dates on tasks, http(s)-only canvas links (Electron's guard against `file:` and
//! `javascript:` links in agent-drawn canvases), one endpoint form per arrow end, and a bulk tag
//! call that adds or removes something. `tools.json` lists them under `refinements`; the test
//! below holds this table to that list.

use serde_json::Value;

const CALENDAR_DATE: &str = "Date must be a real calendar date in YYYY-MM-DD form";
const HTTP_LINK: &str = "link must be an http(s) URL";
const ONE_ENDPOINT: &str = "exactly one of ref or elementId is required";
const SOME_TAG: &str = "Give at least one tag in add or remove.";

/// The value at `path` (`[]` is every item of an array) satisfies `holds`, or the call is refused
/// with `message`. An absent or null value is not checked, as zod's `.nullish()` wraps the check.
struct Refinement {
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

/// The refinements `args` (valid against the tool's JSON Schema) breaks, in the SDK's issue text:
/// the message, then ` at ` and the path (`elements[3].link`) unless it is the root.
pub(super) fn issues(tool: &str, args: &Value) -> Vec<String> {
    let mut issues = Vec::new();
    for refinement in REFINEMENTS
        .iter()
        .filter(|refinement| refinement.tool == tool)
    {
        visit(args, refinement.path, String::new(), &mut |value, at| {
            if value.is_null() || (refinement.holds)(value) {
                return;
            }
            issues.push(if at.is_empty() {
                refinement.message.to_owned()
            } else {
                format!("{} at {at}", refinement.message)
            });
        });
    }
    issues
}

fn visit(value: &Value, path: &[&str], at: String, found: &mut impl FnMut(&Value, &str)) {
    match path.split_first() {
        None => found(value, &at),
        Some((&"[]", rest)) => {
            for (index, item) in value.as_array().into_iter().flatten().enumerate() {
                visit(item, rest, format!("{at}[{index}]"), found);
            }
        }
        Some((key, rest)) => {
            if let Some(child) = value.get(key) {
                let at = if at.is_empty() {
                    (*key).to_owned()
                } else {
                    format!("{at}.{key}")
                };
                visit(child, rest, at, found);
            }
        }
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

/// `(add?.length ?? 0) + (remove?.length ?? 0) > 0` of `note-action-schemas.ts`.
fn some_tag(value: &Value) -> bool {
    let count = |key: &str| value.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    count("add") + count("remove") > 0
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::REFINEMENTS;
    use crate::agent::mcp::schemas::TOOLS_JSON;

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
