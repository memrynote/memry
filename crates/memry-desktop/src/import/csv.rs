//! The CSV importer: `apps/desktop/src/main/import/csv/csv-importer.ts` and
//! `packages/importers/src/csv/{parse-csv,map-rows}.ts`.
//!
//! Each row of each picked file becomes a note under `CSV/`: the title from the first column
//! named `title`, `name` or `subject` (else the first column), every other non-empty cell a
//! property. `applyTemplate` and the `MapRowsOptions` are not ported: no caller passes them.

use std::cell::Cell;
use std::collections::HashMap;
use std::path::Path;

use memry_core::markdown::frontmatter::{YamlMap, YamlValue, is_js_whitespace, js_trim};
use tokio_util::sync::CancellationToken;

use super::messages::{ImportMessage, ImportText, codes, importing_item, status};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportPreview, ImportSink,
    ImportedNote, Importer, ImporterMeta, PreviewCount, PreviewGroup, base_name, read_source_text,
};

const FOLDER: &str = "CSV";
const TITLE_ALIASES: [&str; 3] = ["title", "name", "subject"];
const SAMPLE_MAX: usize = 5;
/// Bytes of the preview's column list. Electron lists every header, so a wide one made the
/// warning (sent twice, as the message and its `columns` param) larger than the header row.
const MAX_COLUMNS_TEXT: usize = 1_000;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Steps of this thread's tokenizer and row mapping: one per character of the input and one
/// per cell a row has.
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

fn step() {
    STEPS.with(|steps| steps.set(steps.get() + 1));
}

/// `ParsedCsv`: the header names and each row's cells.
///
/// `parse-csv.ts` gave every row a record of every header, so a wide header over many short
/// rows cost rows times columns. A row here keeps only the cells it has; a missing one reads as
/// empty, as `raw[c] ?? ''` did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedCsv {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// For each column, the last column of the same name: a repeated header keeps its last cell.
    last_column: Vec<usize>,
}

impl ParsedCsv {
    /// `row[headers[column]]`.
    pub fn cell<'a>(&self, row: &'a [String], column: usize) -> &'a str {
        row.get(self.last_column[column]).map_or("", String::as_str)
    }
}

/// The RFC 4180 tokenizer of `parse-csv.ts`: quoted fields with `""` escapes, commas and line
/// breaks inside quotes, CRLF, CR or LF row ends.
fn tokenize(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        step();
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => in_quotes = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' | '\n' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// `parseCsv`: the first row names the columns (a blank name is `Column N`); rows of blank
/// cells only are dropped.
pub fn parse_csv(text: &str) -> ParsedCsv {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut grid = tokenize(text).into_iter();
    let Some(first) = grid.next() else {
        return ParsedCsv::default();
    };
    let headers: Vec<String> = first
        .iter()
        .enumerate()
        .map(|(at, header)| match js_trim(header) {
            "" => format!("Column {}", at + 1),
            name => name.to_owned(),
        })
        .collect();
    let rows = grid
        .filter(|cells| !cells.iter().all(|cell| js_trim(cell).is_empty()))
        .collect();
    let mut last_by_name = HashMap::new();
    for (at, header) in headers.iter().enumerate() {
        last_by_name.insert(header.as_str(), at);
    }
    let last_column = headers.iter().map(|h| last_by_name[h.as_str()]).collect();
    ParsedCsv {
        headers,
        rows,
        last_column,
    }
}

/// One row's note (`CsvImportNote`).
#[derive(Debug, Clone, PartialEq)]
pub struct CsvNote {
    pub title: String,
    pub properties: YamlMap,
}

/// `CsvImportPlan`.
#[derive(Debug, Clone, PartialEq)]
pub struct CsvPlan {
    pub notes: Vec<CsvNote>,
    pub skipped: usize,
    pub sample_titles: Vec<String>,
    pub warnings: Vec<ImportMessage>,
    pub columns: Vec<String>,
    pub title_column: String,
}

/// `detectTitleColumn`.
fn title_column(headers: &[String]) -> String {
    TITLE_ALIASES
        .iter()
        .find_map(|alias| {
            headers
                .iter()
                .find(|header| js_trim(header).to_lowercase() == *alias)
        })
        .or(headers.first())
        .cloned()
        .unwrap_or_default()
}

/// `sanitizeKey`: white space runs to `_`, leading characters other than ASCII letters and `_`
/// dropped, `property` when nothing is left.
fn sanitize_key(header: &str) -> String {
    let mut key = String::new();
    let mut in_space = false;
    for c in js_trim(header).chars() {
        if is_js_whitespace(c) {
            if !in_space {
                key.push('_');
            }
            in_space = true;
        } else {
            key.push(c);
            in_space = false;
        }
    }
    let key = key.trim_start_matches(|c: char| !(c.is_ascii_alphabetic() || c == '_'));
    if key.is_empty() { "property" } else { key }.to_owned()
}

/// `mapRows` with no options, the only way the importer calls it.
pub fn map_rows(parsed: &ParsedCsv) -> CsvPlan {
    let headers = &parsed.headers;
    if headers.is_empty() {
        return CsvPlan {
            notes: Vec::new(),
            skipped: 0,
            sample_titles: Vec::new(),
            warnings: vec![ImportMessage::coded(
                codes::CSV_NO_HEADERS,
                "CSV file has no headers",
            )],
            columns: Vec::new(),
            title_column: String::new(),
        };
    }
    let title_column = title_column(headers);
    let title_at = headers.iter().position(|h| *h == title_column);
    // `propertyColumns` with their keys: `None` for a column named as the title column.
    let keys: Vec<Option<String>> = headers
        .iter()
        .map(|h| (*h != title_column).then(|| sanitize_key(h)))
        .collect();
    let mut notes = Vec::new();
    let mut warnings = Vec::new();
    let mut skipped = 0;
    for row in &parsed.rows {
        let title = js_trim(title_at.map_or("", |at| parsed.cell(row, at)));
        if title.is_empty() {
            skipped += 1;
            warnings.push(
                ImportMessage::coded(
                    codes::CSV_EMPTY_TITLE,
                    format!("Skipped row with empty title (column \"{title_column}\")"),
                )
                .with_param("column", title_column.as_str()),
            );
            continue;
        }
        // Only the cells the row has: a column past its end, or whose last same-named column
        // is, reads as empty and sets nothing.
        let mut properties = YamlMap::new();
        for (at, key) in keys.iter().enumerate().take(row.len()) {
            step();
            let Some(key) = key else { continue };
            let value = js_trim(parsed.cell(row, at));
            if !value.is_empty() {
                properties.insert(key.clone(), YamlValue::String(value.to_owned()));
            }
        }
        notes.push(CsvNote {
            title: title.to_owned(),
            properties,
        });
    }
    CsvPlan {
        sample_titles: notes
            .iter()
            .take(SAMPLE_MAX)
            .map(|n| n.title.clone())
            .collect(),
        notes,
        skipped,
        warnings,
        columns: headers.clone(),
        title_column,
    }
}

fn read_plan(path: &Path) -> std::io::Result<CsvPlan> {
    Ok(map_rows(&parse_csv(&read_source_text(path)?)))
}

pub struct CsvImporter;

impl Importer for CsvImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "csv".to_owned(),
            name: "CSV".to_owned(),
            description_key: "import.sources.csv".to_owned(),
            file_spec: FileSpec {
                label: "CSV files".to_owned(),
                extensions: vec!["csv".to_owned()],
                allow_multiple: true,
                ..FileSpec::default()
            },
            supports_preview: true,
            account_based: false,
        }
    }

    fn preview(
        &self,
        input: &ImportInput,
        cancel: &CancellationToken,
    ) -> Result<ImportPreview, ImportError> {
        let mut groups = Vec::new();
        for source in &input.source_paths {
            if cancel.is_cancelled() {
                break;
            }
            let path = Path::new(source);
            let label = base_name(path);
            groups.push(match read_plan(path) {
                Ok(plan) => preview_group(label, plan),
                Err(error) => PreviewGroup {
                    label,
                    counts: Vec::new(),
                    sample_titles: None,
                    warnings: None,
                    error: Some(ImportText::Message(ImportMessage {
                        code: None,
                        message: error.to_string(),
                        params: None,
                    })),
                },
            });
        }
        Ok(ImportPreview { groups })
    }

    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), ImportError> {
        ctx.set_phase(ImportPhase::Importing);
        ctx.status(status("csvImporting"));

        let plans: Vec<(String, Result<CsvPlan, String>)> = input
            .source_paths
            .iter()
            .map(|source| {
                let path = Path::new(source);
                (base_name(path), read_plan(path).map_err(|e| e.to_string()))
            })
            .collect();
        let total = plans
            .iter()
            .map(|(_, plan)| plan.as_ref().map_or(0, |plan| plan.notes.len()))
            .sum();
        let mut done = 0;
        ctx.report_progress(0, total);

        for (file_name, plan) in plans {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let plan = match plan {
                Ok(plan) => plan,
                Err(error) => {
                    tracing::error!(scope = "import", "CSV import failed for a file");
                    ctx.report_failed(&file_name, &error);
                    continue;
                }
            };
            for note in plan.notes {
                if ctx.is_cancelled() {
                    return Ok(());
                }
                ctx.status(importing_item(&note.title));
                let title = note.title.clone();
                let created = sink.create_note(ImportedNote {
                    id: None,
                    title: note.title,
                    content: String::new(),
                    folder: Some(FOLDER.to_owned()),
                    tags: Vec::new(),
                    properties: note.properties,
                    created: None,
                    modified: None,
                });
                match created {
                    Ok(()) => ctx.report_imported(),
                    Err(error) => {
                        tracing::warn!(scope = "import", "CSV note import failed");
                        ctx.report_failed(&title, &error.0);
                    }
                }
                done += 1;
                ctx.report_progress(done, total);
            }
            for _ in 0..plan.skipped {
                ctx.report_skipped(&file_name, Some(ImportText::from("empty title")));
            }
        }
        Ok(())
    }
}

/// `plan.columns.join(', ')`, cut at `MAX_COLUMNS_TEXT` bytes and then ending in an ellipsis.
fn columns_text(columns: &[String]) -> String {
    let mut text = String::new();
    for (i, column) in columns.iter().enumerate() {
        if i > 0 {
            text.push_str(", ");
        }
        text.push_str(column);
        if text.len() > MAX_COLUMNS_TEXT {
            let mut cut = MAX_COLUMNS_TEXT;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push('…');
            break;
        }
    }
    text
}

/// `previewFile`'s group for a plan.
fn preview_group(label: String, plan: CsvPlan) -> PreviewGroup {
    let columns = columns_text(&plan.columns);
    let mut warnings: Vec<ImportText> =
        plan.warnings.into_iter().map(ImportText::Message).collect();
    warnings.push(ImportText::Message(
        ImportMessage::coded(codes::CSV_COLUMNS, format!("Columns: {columns}"))
            .with_param("columns", columns.as_str()),
    ));
    warnings.push(ImportText::Message(
        ImportMessage::coded(
            codes::CSV_TITLE_COLUMN,
            format!(
                "Title from \"{}\"; other columns saved as properties",
                plan.title_column
            ),
        )
        .with_param("column", plan.title_column.as_str()),
    ));
    PreviewGroup {
        label,
        counts: vec![
            PreviewCount {
                label_key: "import.stats.notes".to_owned(),
                value: plan.notes.len(),
            },
            PreviewCount {
                label_key: "import.stats.skipped".to_owned(),
                value: plan.skipped,
            },
        ],
        sample_titles: Some(plan.sample_titles),
        warnings: Some(warnings),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The preview's "Columns:" warning for `header`, as `preview` builds it from a file.
    fn columns_warning(header: &str) -> ImportMessage {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wide.csv");
        std::fs::write(&path, format!("{header}\nrow\n")).unwrap();
        let input = ImportInput {
            source_paths: vec![path.to_string_lossy().into_owned()],
            options: None,
        };
        let preview = CsvImporter
            .preview(&input, &CancellationToken::new())
            .unwrap();
        let warnings = preview.groups[0].warnings.clone().unwrap();
        warnings
            .into_iter()
            .find_map(|text| match text {
                ImportText::Message(message)
                    if message.code.as_deref() == Some(codes::CSV_COLUMNS) =>
                {
                    Some(message)
                }
                _ => None,
            })
            .unwrap()
    }

    /// The warning lists the header, so its size follows the header's: a wide header's list
    /// is cut at `MAX_COLUMNS_TEXT` and ends in an ellipsis.
    #[test]
    fn a_wide_header_gives_a_bounded_columns_warning() {
        let wide: Vec<String> = (0..5_000).map(|i| format!("column_{i}")).collect();
        // Multi-byte names put the byte cap inside a character: `€` (3 bytes) and `aé` (1 + 2)
        // do at 1,000, `😀` (4) does not.
        for header in [
            wide.join(","),
            "x".repeat(1 << 20),
            "€".repeat(400),
            "😀".repeat(300),
            "aé".repeat(400),
        ] {
            let warning = columns_warning(&header);
            let columns = warning.params.as_ref().unwrap()["columns"]
                .as_str()
                .unwrap();
            assert!(columns.len() <= MAX_COLUMNS_TEXT + '…'.len_utf8());
            assert!(columns.ends_with('…'));
            assert_eq!(warning.message, format!("Columns: {columns}"));
        }
        let narrow = columns_warning("title,body");
        assert_eq!(narrow.message, "Columns: title, body");
    }
}
