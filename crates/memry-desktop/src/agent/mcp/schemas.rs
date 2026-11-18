//! The tool catalogue: Electron's `tools/list`, read from the contract file
//! `packages/contracts/test-vectors/agent-mcp/tools.json` (generated from `TOOL_SCHEMAS` in
//! `agent/mcp/tools/schemas.ts`), with each input schema compiled once per process.
//!
//! Electron parses tool input with zod, which also fills `.default(...)` values; the JSON Schema
//! carries them as `default`, so [`ToolSpec::parse`] fills them after validating. zod's
//! refinements are not in the JSON Schema; [`super::refine`] checks them after the defaults.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use jsonschema::paths::Location;
use jsonschema::{Keyword, ValidationError};
use rmcp::model::{JsonObject, Tool};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::refine;

pub(super) const TOOLS_JSON: &str =
    include_str!("../../../../../packages/contracts/test-vectors/agent-mcp/tools.json");

/// Issues named in a validation reply. Every issue of an array of thousands of wrong items would
/// grow the reply past its input; the agent needs the first ones to fix the call.
const MAX_ISSUES: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolClass {
    /// Open to every client that holds the bearer.
    Read,
    /// Needs the turn's write capability and the user's approval.
    Write,
}

#[derive(Deserialize)]
struct ToolsFile {
    tools: Vec<ToolEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolEntry {
    name: String,
    class: ToolClass,
    description: String,
    input_schema: JsonObject,
}

pub struct ToolSpec {
    pub class: ToolClass,
    pub tool: Tool,
    validator: jsonschema::Validator,
}

impl ToolSpec {
    pub fn name(&self) -> &str {
        &self.tool.name
    }

    /// The arguments with schema defaults filled, or the validation failure text.
    pub fn parse(&self, mut args: Value) -> Result<Value, String> {
        report(self.validator.iter_errors(&args).map(|error| {
            let path = error.instance_path().to_string();
            let path = path.trim_start_matches('/').replace('/', ".");
            if path.is_empty() {
                error.to_string()
            } else {
                format!("{error} at {path}")
            }
        }))?;
        fill_defaults(&mut args, &self.tool.input_schema);
        report(refine::issues(self.name(), &args).into_iter())?;
        Ok(args)
    }
}

/// The first [`MAX_ISSUES`] issues and the count of the rest, or nothing when there are none.
fn report(mut issues: impl Iterator<Item = String>) -> Result<(), String> {
    let mut shown: Vec<String> = issues.by_ref().take(MAX_ISSUES).collect();
    if shown.is_empty() {
        return Ok(());
    }
    let more = issues.count();
    if more > 0 {
        shown.push(format!("and {more} more"));
    }
    Err(shown.join("; "))
}

pub struct Catalog {
    tools: Vec<ToolSpec>,
    by_name: HashMap<String, usize>,
}

impl Catalog {
    pub fn get(&self, name: &str) -> Option<&ToolSpec> {
        self.by_name
            .get(name)
            .map(|index| &self.tools[index.to_owned()])
    }

    pub fn tools(&self) -> impl Iterator<Item = &ToolSpec> {
        self.tools.iter()
    }
}

/// The catalogue of this build. The contract file is embedded and tested, so a parse or compile
/// failure is a build defect.
pub fn catalog() -> &'static Catalog {
    static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
        #[allow(clippy::expect_used)] // embedded at build time; `agent_mcp` tests load it
        let file: ToolsFile = serde_json::from_str(TOOLS_JSON).expect("tools.json parses");
        let tools: Vec<ToolSpec> = file
            .tools
            .into_iter()
            .map(|entry| {
                let schema = Value::Object(entry.input_schema.clone());
                #[allow(clippy::expect_used)] // as above
                let validator = jsonschema::options()
                    .with_keyword("minLength", min_length)
                    .with_keyword("maxLength", max_length)
                    .build(&schema)
                    .expect("tool schema compiles");
                ToolSpec {
                    class: entry.class,
                    tool: Tool::new(entry.name, entry.description, Arc::new(entry.input_schema)),
                    validator,
                }
            })
            .collect();
        let by_name = tools
            .iter()
            .enumerate()
            .map(|(i, t)| (t.name().to_owned(), i))
            .collect();
        Catalog { tools, by_name }
    });
    &CATALOG
}

/// `minLength` and `maxLength` as zod counts them: in UTF-16 code units, JavaScript's `length`.
/// JSON Schema counts code points, so 33 emoji would pass a limit of 64 that zod refuses.
struct Utf16Length {
    limit: u64,
    max: bool,
}

type LengthKeyword<'a> = Result<Box<dyn for<'i> Keyword<'i>>, ValidationError<'a>>;

fn min_length<'a>(_: &'a Map<String, Value>, limit: &'a Value, _: Location) -> LengthKeyword<'a> {
    utf16_length(limit, false)
}

fn max_length<'a>(_: &'a Map<String, Value>, limit: &'a Value, _: Location) -> LengthKeyword<'a> {
    utf16_length(limit, true)
}

fn utf16_length(limit: &Value, max: bool) -> LengthKeyword<'static> {
    let limit = limit.as_u64().ok_or_else(|| {
        ValidationError::schema("a string length limit is a non-negative integer")
    })?;
    Ok(Box::new(Utf16Length { limit, max }))
}

impl<'i> Keyword<'i> for Utf16Length {
    /// zod's issue text for the bound.
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        if self.is_valid(instance) {
            return Ok(());
        }
        Err(ValidationError::custom(if self.max {
            format!(
                "Too big: expected string to have <={} characters",
                self.limit
            )
        } else {
            format!(
                "Too small: expected string to have >={} characters",
                self.limit
            )
        }))
    }

    fn is_valid(&self, instance: &'i Value) -> bool {
        let Some(text) = instance.as_str() else {
            return true;
        };
        let units = text.encode_utf16().count() as u64;
        if self.max {
            units <= self.limit
        } else {
            units >= self.limit
        }
    }
}

/// Inserts each absent property's `default`, through nested objects and array items, as zod's
/// `.default()` does on parse.
fn fill_defaults(value: &mut Value, schema: &Map<String, Value>) {
    match value {
        Value::Object(object) => {
            let Some(Value::Object(properties)) = schema.get("properties") else {
                return;
            };
            for (key, property) in properties {
                let Value::Object(property) = property else {
                    continue;
                };
                match object.get_mut(key) {
                    Some(present) => fill_defaults(present, property),
                    None => {
                        if let Some(default) = property.get("default") {
                            object.insert(key.clone(), default.clone());
                        }
                    }
                }
            }
        }
        Value::Array(items) => {
            let Some(Value::Object(item_schema)) = schema.get("items") else {
                return;
            };
            for item in items {
                fill_defaults(item, item_schema);
            }
        }
        _ => {}
    }
}
