//! The desktop API call check of `vault_desktop_read` and `vault_desktop_write`: Electron's
//! `assertDesktopApiArgs` (`agent/mcp/tools/desktop-api-params.ts`) with the refusal text of
//! `desktop-api-issues.ts`. Each operation's arguments are a zod tuple whose JSON Schema is in
//! `packages/contracts/test-vectors/agent-mcp/desktop-ops.json`; the zod walk parses them, and a
//! refusal names each field, the type it takes and what was sent. It runs before the write gate,
//! so the user is never asked to approve a call that cannot run.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::errors::{ToolError, ToolErrorCode};
use super::zod::{
    self, Code, Issue, Seg, Walker, js_json, js_number, js_prefix, js_quoted_prefix, resolve_ref,
};

const DESKTOP_OPS_JSON: &str =
    include_str!("../../../../../packages/contracts/test-vectors/agent-mcp/desktop-ops.json");

const EXPECTED_MAX_CHARS: usize = 400;
const RECEIVED_MAX_CHARS: usize = 60;
const RENDER_MAX_DEPTH: usize = 3;

#[derive(Deserialize)]
struct OpsFile {
    operations: Vec<OpEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpEntry {
    operation: String,
    params: Vec<ParamEntry>,
    args_schema: Map<String, Value>,
}

#[derive(Deserialize)]
struct ParamEntry {
    name: String,
}

/// An operation's parameter names and the zod tuple of its arguments: the longest call the
/// published schema allows (`desktopArgsItemSchemas`), with the optional tail from `minItems`.
pub(super) struct Operation {
    params: Vec<String>,
    tuple: Value,
}

fn operations() -> &'static HashMap<String, Operation> {
    static OPERATIONS: LazyLock<HashMap<String, Operation>> = LazyLock::new(|| {
        #[allow(clippy::expect_used)] // embedded at build time; `agent_mcp` tests load it
        let file: OpsFile =
            serde_json::from_str(DESKTOP_OPS_JSON).expect("desktop-ops.json parses");
        file.operations
            .into_iter()
            .map(|entry| {
                let schema = entry.args_schema;
                let longest = schema
                    .get("anyOf")
                    .and_then(Value::as_array)
                    .and_then(|calls| calls.last())
                    .unwrap_or(&Value::Null);
                let items = longest
                    .get("prefixItems")
                    .or_else(|| schema.get("prefixItems"))
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                let mut tuple = Map::new();
                tuple.insert("type".into(), "array".into());
                tuple.insert("prefixItems".into(), items);
                tuple.insert(
                    "minItems".into(),
                    schema.get("minItems").cloned().unwrap_or(json!(0)),
                );
                if let Some(defs) = schema.get("$defs") {
                    tuple.insert("$defs".into(), defs.clone());
                }
                let tuple = Value::Object(tuple);
                #[allow(clippy::expect_used)] // as above
                zod::lint(&tuple).expect("desktop argument schema is one the zod walk reads");
                let params = entry.params.into_iter().map(|param| param.name).collect();
                (entry.operation, Operation { params, tuple })
            })
            .collect()
    });
    &OPERATIONS
}

/// Refuses a desktop API call whose `args` the operation does not take. Any other tool passes.
pub(super) fn check(tool: &str, input: &Value) -> Result<(), ToolError> {
    if tool != "vault_desktop_read" && tool != "vault_desktop_write" {
        return Ok(());
    }
    let operation = input["operation"].as_str().unwrap_or_default();
    let args = input.get("args").cloned().unwrap_or_else(|| json!([]));
    let Some(op) = operations().get(operation) else {
        return Err(ToolError::new(
            ToolErrorCode::Validation,
            format!("{operation} is not a desktop API operation. Nothing was run."),
        ));
    };
    assert_args(operation, op, &args)
}

fn assert_args(operation: &str, op: &'static Operation, args: &Value) -> Result<(), ToolError> {
    let params = &op.params;
    let sent = args.as_array().map_or(0, Vec::len);
    let describe = format!(
        "vault_desktop_describe with operation \"{operation}\" returns the full argument schema."
    );
    let refuse = |message: String, details: Value| {
        let Value::Object(details) = details else {
            unreachable!("details are an object literal")
        };
        Err(ToolError::new(ToolErrorCode::Validation, message).with_details(details))
    };
    if sent > params.len() {
        let takes = match params.len() {
            0 => "takes no arguments".to_owned(),
            1 => format!("takes 1 argument ({})", params.join(", ")),
            count => format!("takes {count} arguments ({})", params.join(", ")),
        };
        return refuse(
            format!("{operation} {takes}, but this call passed {sent}. Nothing was run."),
            json!({ "operation": operation, "params": params, "received": sent }),
        );
    }
    let outcome = Walker::new(&op.tuple, None).check(&op.tuple, Some(args));
    if outcome.is_ok() {
        return Ok(());
    }
    let reader = Reader { op, args };
    let issues = reader.collect(&outcome.issues, &[]);
    let unknown: Vec<&str> = issues
        .iter()
        .filter(|issue| issue.unknown)
        .map(|issue| issue.field.as_str())
        .collect();
    let listed: Vec<Value> = issues.iter().map(ArgIssue::to_json).collect();
    if unknown.len() == issues.len() {
        return refuse(
            format!(
                "{operation} does not take {}. Nothing was run. {describe}",
                unknown.join(", ")
            ),
            json!({ "operation": operation, "unknown": unknown, "issues": listed }),
        );
    }
    let text: Vec<String> = issues.iter().map(ArgIssue::text).collect();
    refuse(
        format!(
            "{operation} arguments do not match its schema: {}. Nothing was run. {describe}",
            text.join("; ")
        ),
        json!({ "operation": operation, "params": params, "issues": listed }),
    )
}

/// `DesktopArgIssue`: one reason the call was refused, in terms an agent can act on.
#[derive(Default)]
struct ArgIssue {
    field: String,
    unknown: bool,
    expected: Option<String>,
    allowed: Option<Vec<Value>>,
    problem: Option<String>,
    received: Option<String>,
}

impl ArgIssue {
    fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("field".into(), self.field.clone().into());
        if self.unknown {
            object.insert("unknown".into(), true.into());
        }
        let fields = [
            ("expected", self.expected.clone().map(Value::from)),
            ("allowed", self.allowed.clone().map(Value::from)),
            ("problem", self.problem.clone().map(Value::from)),
            ("received", self.received.clone().map(Value::from)),
        ];
        for (key, value) in fields {
            if let Some(value) = value {
                object.insert(key.into(), value);
            }
        }
        Value::Object(object)
    }

    /// `formatDesktopArgIssue`.
    fn text(&self) -> String {
        let received = self.received.as_deref().unwrap_or("undefined");
        match (&self.expected, &self.problem) {
            _ if self.unknown => format!("{}: not a parameter of this operation", self.field),
            (Some(expected), _) => format!("{}: expected {expected}, got {received}", self.field),
            (None, problem) => {
                let problem = problem.as_deref().unwrap_or("invalid");
                format!("{}: {problem}, got {received}", self.field)
            }
        }
    }
}

/// `desktopArgIssues`: zod's issues turned into one entry per field.
struct Reader<'a> {
    op: &'static Operation,
    args: &'a Value,
}

impl Reader<'_> {
    fn field(&self, path: &[Seg]) -> String {
        let Some((first, rest)) = path.split_first() else {
            return "args".to_owned();
        };
        let mut parts = vec![match first {
            Seg::Index(index) => self
                .op
                .params
                .get(*index)
                .cloned()
                .unwrap_or_else(|| format!("args.{index}")),
            Seg::Key(key) => format!("args.{key}"),
        }];
        parts.extend(rest.iter().map(seg_text));
        parts.join(".")
    }

    fn at_path(&self, path: &[Seg]) -> ArgIssue {
        let mut issue = ArgIssue {
            field: self.field(path),
            received: Some(describe_received(value_at(self.args, path))),
            ..ArgIssue::default()
        };
        if let Some(target) = schema_at(&self.op.tuple, path) {
            let (expected, allowed) = describe_expected(&self.op.tuple, &target);
            issue.expected = Some(expected);
            issue.allowed = allowed;
        }
        issue
    }

    fn collect(&self, list: &[Issue], at: &[Seg]) -> Vec<ArgIssue> {
        let mut out = Vec::new();
        for issue in list {
            let path: Vec<Seg> = at.iter().chain(&issue.path).cloned().collect();
            match issue.code {
                Code::UnrecognizedKeys => out.extend(issue.keys.iter().map(|key| {
                    let mut field = path.clone();
                    field.push(Seg::Key(key.clone()));
                    ArgIssue {
                        field: self.field(&field),
                        unknown: true,
                        ..ArgIssue::default()
                    }
                })),
                Code::InvalidUnion => {
                    let fitting: Vec<&Vec<Issue>> = issue
                        .union
                        .iter()
                        .filter(|option| !misses_option(option))
                        .collect();
                    let meant = issue
                        .union
                        .iter()
                        .find(|option| only_unknown_keys(option))
                        .or(if fitting.len() == 1 {
                            fitting.first().copied()
                        } else {
                            None
                        });
                    match meant {
                        Some(meant) => out.extend(self.collect(meant, &path)),
                        None => out.push(self.at_path(&path)),
                    }
                }
                Code::InvalidType => out.push(self.at_path(&path)),
                Code::InvalidValue => {
                    let expected = match issue.values.as_slice() {
                        [only] => js_json(only),
                        values => {
                            let shown: Vec<String> = values.iter().map(js_json).collect();
                            format!("one of {}", shown.join(", "))
                        }
                    };
                    out.push(ArgIssue {
                        field: self.field(&path),
                        expected: Some(expected),
                        allowed: Some(issue.values.clone()),
                        received: Some(describe_received(value_at(self.args, &path))),
                        ..ArgIssue::default()
                    });
                }
                _ => out.push(ArgIssue {
                    field: self.field(&path),
                    problem: Some(issue.message.clone()),
                    received: Some(describe_received(value_at(self.args, &path))),
                    ..ArgIssue::default()
                }),
            }
        }
        out
    }
}

fn seg_text(seg: &Seg) -> String {
    match seg {
        Seg::Index(index) => index.to_string(),
        Seg::Key(key) => key.clone(),
    }
}

/// A union option that failed on the value's own type or on a literal key (the discriminator)
/// is not the option the value was meant for.
fn misses_option(issues: &[Issue]) -> bool {
    issues.iter().any(|issue| {
        issue.path.is_empty() || (issue.code == Code::InvalidValue && issue.path.len() == 1)
    })
}

fn only_unknown_keys(issues: &[Issue]) -> bool {
    issues.iter().all(|issue| {
        issue.code == Code::UnrecognizedKeys
            || (issue.code == Code::InvalidUnion
                && issue.union.iter().any(|option| only_unknown_keys(option)))
    })
}

fn value_at<'v>(args: &'v Value, path: &[Seg]) -> Option<&'v Value> {
    let mut current = args;
    for seg in path {
        current = match (current, seg) {
            (Value::Array(items), Seg::Index(index)) => items.get(*index)?,
            (Value::Array(items), Seg::Key(key)) => items.get(key.parse::<usize>().ok()?)?,
            (Value::Object(object), seg) => object.get(&seg_text(seg))?,
            _ => return None,
        };
    }
    Some(current)
}

/// zod's `unwrap` as the JSON Schema shows it: a `$ref` (`z.lazy`) and `.nullable()`.
fn unwrap<'s>(root: &'s Value, mut node: &'s Value) -> &'s Value {
    for _ in 0..zod::MAX_DEPTH {
        if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
            node = resolve_ref(root, reference).unwrap_or(&Value::Null);
            continue;
        }
        match node
            .get("anyOf")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
        {
            Some([inner, null]) | Some([null, inner]) if null == &json!({ "type": "null" }) => {
                node = inner;
            }
            _ => return node,
        }
    }
    node
}

fn child_schema(root: &Value, node: &Value, seg: &Seg) -> Option<Value> {
    let inner = unwrap(root, node);
    let key = seg_text(seg);
    if let Some(options) = inner
        .get("anyOf")
        .or_else(|| inner.get("oneOf"))
        .and_then(Value::as_array)
    {
        let found: Vec<Value> = options
            .iter()
            .filter_map(|option| child_schema(root, option, seg))
            .collect();
        return match found.len() {
            0 => None,
            1 => found.into_iter().next(),
            _ => Some(json!({ "anyOf": found })),
        };
    }
    if let Some(items) = inner.get("prefixItems").and_then(Value::as_array) {
        let item = key.parse::<usize>().ok().and_then(|index| items.get(index));
        return item.or_else(|| inner.get("items")).cloned();
    }
    match inner.get("type").and_then(Value::as_str) {
        Some("object") if inner.get("propertyNames").is_some() => {
            inner.get("additionalProperties").cloned()
        }
        Some("object") => inner.get("properties")?.get(&key).cloned(),
        Some("array") => inner.get("items").cloned(),
        _ => None,
    }
}

fn schema_at(root: &Value, path: &[Seg]) -> Option<Value> {
    let mut current = root.clone();
    for seg in path {
        current = child_schema(root, &current, seg)?;
    }
    Some(current)
}

/// The fixed values a schema takes, or `None` when it takes more than literals.
fn literal_values(node: &Value) -> Option<Vec<Value>> {
    if let Some(Value::Array(values)) = node.get("enum") {
        return Some(values.clone());
    }
    if let Some(value) = node.get("const") {
        return Some(vec![value.clone()]);
    }
    let options = node
        .get("anyOf")
        .or_else(|| node.get("oneOf"))?
        .as_array()?;
    let mut values = Vec::new();
    for option in options {
        values.extend(literal_values(option)?);
    }
    Some(values)
}

/// `renderType`: a JSON Schema node written like a TypeScript type.
fn render_type(node: &Value, root: &Value, depth: usize) -> String {
    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        return match resolve_ref(root, reference) {
            Some(target) if depth < RENDER_MAX_DEPTH => render_type(target, root, depth + 1),
            _ => "object".to_owned(),
        };
    }
    if let Some(literals) = literal_values(node) {
        return literals.iter().map(js_json).collect::<Vec<_>>().join(" | ");
    }
    if let Some(options) = node
        .get("anyOf")
        .or_else(|| node.get("oneOf"))
        .and_then(Value::as_array)
    {
        let mut rendered: Vec<String> = Vec::new();
        for option in options {
            let text = render_type(option, root, depth);
            if !rendered.contains(&text) {
                rendered.push(text);
            }
        }
        return rendered.join(" | ");
    }
    match node.get("type") {
        Some(Value::Array(members)) => members
            .iter()
            .map(|member| {
                let mut single = node.clone();
                single["type"] = member.clone();
                render_type(&single, root, depth)
            })
            .collect::<Vec<_>>()
            .join(" | "),
        Some(Value::String(kind)) if kind == "array" => {
            if let Some(items) = node.get("prefixItems").and_then(Value::as_array) {
                let items: Vec<String> = items
                    .iter()
                    .map(|item| render_type(item, root, depth))
                    .collect();
                return format!("[{}]", items.join(", "));
            }
            let item = node.get("items").map_or_else(
                || "any".to_owned(),
                |items| render_type(items, root, depth + 1),
            );
            if item.contains(" | ") {
                format!("({item})[]")
            } else {
                format!("{item}[]")
            }
        }
        Some(Value::String(kind)) if kind == "object" => {
            if depth >= RENDER_MAX_DEPTH {
                return "object".to_owned();
            }
            if let Some(properties) = node.get("properties").and_then(Value::as_object)
                && !properties.is_empty()
            {
                let required = |key: &str| {
                    node.get("required")
                        .and_then(Value::as_array)
                        .is_some_and(|list| list.iter().any(|name| name == key))
                };
                let fields: Vec<String> = properties
                    .iter()
                    .map(|(key, value)| {
                        let mark = if required(key) { "" } else { "?" };
                        format!("{key}{mark}: {}", render_type(value, root, depth + 1))
                    })
                    .collect();
                return format!("{{ {} }}", fields.join(", "));
            }
            match node.get("additionalProperties") {
                Some(values @ Value::Object(_)) => {
                    format!("Record<string, {}>", render_type(values, root, depth + 1))
                }
                _ => "object".to_owned(),
            }
        }
        Some(Value::String(kind)) => kind.clone(),
        _ => "any".to_owned(),
    }
}

/// `describeExpected`: what a field takes, "one of …" for a fixed set.
fn describe_expected(root: &Value, target: &Value) -> (String, Option<Vec<Value>>) {
    let node = match target.get("$ref").and_then(Value::as_str) {
        Some(reference) => resolve_ref(root, reference).unwrap_or(target),
        None => target,
    };
    let literals = literal_values(node);
    if let Some(values) = &literals
        && values.len() > 1
    {
        let shown: Vec<String> = values.iter().map(js_json).collect();
        return (format!("one of {}", shown.join(", ")), literals);
    }
    let rendered = render_type(node, root, 0);
    let (kept, cut) = js_prefix(&rendered, EXPECTED_MAX_CHARS);
    (if cut { format!("{kept}…") } else { rendered }, literals)
}

fn describe_received(value: Option<&Value>) -> String {
    match value {
        None => "nothing".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Array(_)) => "an array".to_owned(),
        Some(Value::Object(_)) => "an object".to_owned(),
        Some(Value::String(text)) => js_quoted_prefix(text, RECEIVED_MAX_CHARS, "..."),
        Some(Value::Number(number)) => js_number(number),
        Some(Value::Bool(flag)) => flag.to_string(),
    }
}
