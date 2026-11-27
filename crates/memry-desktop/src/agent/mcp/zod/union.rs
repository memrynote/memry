//! `anyOf` and `oneOf`: `.nullable()`, `z.union` and `z.discriminatedUnion`.

use serde_json::Value;

use super::{Code, Issue, Outcome, Seg, Walker, same};

impl<'s> Walker<'s> {
    /// `.nullable()`, or `z.union`: the first option that passes wins; a single option that
    /// failed only its checks speaks for the union; otherwise one `invalid_union`.
    pub(super) fn any_of(&mut self, options: &'s [Value], value: Option<&Value>) -> Outcome {
        if let [first, second] = options
            && (is_null(first) || is_null(second))
        {
            if value.is_some_and(Value::is_null) {
                return Outcome::default();
            }
            return self.check(if is_null(second) { first } else { second }, value);
        }
        if let [only] = options {
            return self.check(only, value);
        }
        let mut results = Vec::with_capacity(options.len());
        for option in options {
            let result = self.check(option, value);
            if result.is_ok() {
                return result;
            }
            results.push(result);
        }
        let mut open = results.iter().filter(|result| !result.aborted());
        if let (Some(_), None) = (open.next(), open.next()) {
            let index = results.iter().position(|result| !result.aborted());
            return results.swap_remove(index.unwrap_or_default());
        }
        self.invalid_union(results)
    }

    fn invalid_union(&self, results: Vec<Outcome>) -> Outcome {
        let mut issue = self.issue(Code::InvalidUnion, "Invalid input".into(), false);
        let depth = self.path.len();
        issue.union = results
            .into_iter()
            .map(|result| {
                result
                    .issues
                    .into_iter()
                    .map(|issue| relative(issue, depth))
                    .collect()
            })
            .collect();
        let mut out = Outcome::default();
        out.push(issue);
        out
    }

    /// `z.discriminatedUnion`, printed as `oneOf` of objects that share a `const` key ([`lint`]
    /// refuses a `oneOf` without one).
    pub(super) fn one_of(&mut self, options: &'s [Value], value: Option<&Value>) -> Outcome {
        let mut out = Outcome::default();
        let key = discriminator(options).unwrap_or_default();
        let Some(object) = value.and_then(Value::as_object) else {
            out.push(self.invalid_type("object", value));
            return out;
        };
        let tag = object.get(key);
        let chosen = options.iter().find(|option| {
            tag.is_some_and(|tag| {
                literals_of(&option["properties"][key])
                    .iter()
                    .any(|allowed| same(allowed, tag))
            })
        });
        if let Some(option) = chosen {
            return self.check(option, value);
        }
        self.path.push(Seg::Key(key.to_owned()));
        out.push(self.issue(Code::InvalidUnion, "Invalid input".into(), false));
        self.path.pop();
        out
    }
}

fn is_null(schema: &Value) -> bool {
    schema
        .as_object()
        .is_some_and(|schema| schema.len() == 1 && schema.get("type") == Some(&"null".into()))
}

fn relative(mut issue: Issue, depth: usize) -> Issue {
    issue.path.drain(..depth.min(issue.path.len()));
    issue
}

fn literals_of(node: &Value) -> Vec<Value> {
    match (node.get("const"), node.get("enum")) {
        (Some(value), _) => vec![value.clone()],
        (_, Some(Value::Array(values))) => values.clone(),
        _ => Vec::new(),
    }
}

/// The key every option fixes to literals, which is how zod prints a discriminated union.
pub(super) fn discriminator(options: &[Value]) -> Option<&str> {
    let first = options.first()?.get("properties")?.as_object()?;
    first.keys().map(String::as_str).find(|key| {
        options
            .iter()
            .all(|option| !literals_of(&option["properties"][*key]).is_empty())
    })
}
