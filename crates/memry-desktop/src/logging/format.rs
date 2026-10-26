//! `YYYY-MM-DD HH:MM:SS.mmm [level] [scope] text`, the line `logger.ts` writes.

use std::fmt::{self, Write as _};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::registry::LookupSpan;

use super::localtime;

pub struct LineFormat;

/// Collects the message, the `scope` field and every other field.
#[derive(Default)]
struct Fields {
    message: String,
    scope: Option<String>,
    rest: String,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        match field.name() {
            "message" => {
                let _ = write!(self.message, "{value:?}");
            }
            "scope" => self.scope = Some(format!("{value:?}").trim_matches('"').to_owned()),
            name => {
                let _ = write!(self.rest, " {name}={value:?}");
            }
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "message" => self.message.push_str(value),
            "scope" => self.scope = Some(value.to_owned()),
            name => {
                let _ = write!(self.rest, " {name}={value}");
            }
        }
    }
}

fn level_name(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => "error",
        Level::WARN => "warn",
        Level::INFO => "info",
        Level::DEBUG => "debug",
        Level::TRACE => "trace",
    }
}

/// The `scope` field, else the last path segment of the module target.
fn scope_of(fields: &Fields, target: &str) -> String {
    fields
        .scope
        .clone()
        .unwrap_or_else(|| target.rsplit("::").next().unwrap_or(target).to_owned())
}

pub fn render(level: &Level, target: &str, fields: &impl FieldsView) -> String {
    format!(
        "{} [{}] [{}] {}{}\n",
        localtime::now().render(),
        level_name(level),
        fields.scope(target),
        fields.message(),
        fields.rest()
    )
}

/// What `render` needs from a visited event, so tests can build one by hand.
pub trait FieldsView {
    fn scope(&self, target: &str) -> String;
    fn message(&self) -> &str;
    fn rest(&self) -> &str;
}

impl FieldsView for Fields {
    fn scope(&self, target: &str) -> String {
        scope_of(self, target)
    }
    fn message(&self) -> &str {
        &self.message
    }
    fn rest(&self) -> &str {
        &self.rest
    }
}

impl<S, N> FormatEvent<S, N> for LineFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let mut fields = Fields::default();
        event.record(&mut fields);
        let meta = event.metadata();
        writer.write_str(&render(meta.level(), meta.target(), &fields))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Hand(&'static str, Option<&'static str>);

    impl FieldsView for Hand {
        fn scope(&self, target: &str) -> String {
            self.1.map_or_else(
                || target.rsplit("::").next().unwrap().to_owned(),
                str::to_owned,
            )
        }
        fn message(&self) -> &str {
            self.0
        }
        fn rest(&self) -> &str {
            ""
        }
    }

    #[test]
    fn a_line_has_timestamp_level_scope_and_text() {
        let line = render(&Level::WARN, "memry_desktop::session", &Hand("hello", None));
        let re = regex::Regex::new(
            r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[warn\] \[session\] hello\n$",
        )
        .unwrap();
        assert!(re.is_match(&line), "{line:?}");
        let scoped = render(&Level::INFO, "x::y", &Hand("m", Some("Startup")));
        assert!(scoped.contains("[info] [Startup] m"));
    }
}
