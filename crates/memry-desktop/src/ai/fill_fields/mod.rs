//! Agent fill (`ai-inline/fill-fields.ts` and `fill-fields-status.ts` of Electron): the
//! inline AI model reads one note and proposes values for the empty fields of its header tags.
//! Nothing here writes: the renderer shows the proposals as ghost values and writes an accepted
//! one through the normal property path. Only this note is sent; a relation's name is matched to
//! the vault's objects here, afterwards.

pub mod values;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use memry_core::domain::tag_objects::Resolved;
use memry_core::domain::tag_objects::search::ObjectMatch;
use memry_core::domain::tag_schema::ResolvedField;
use memry_core::domain::tags::tag_key;
use memry_core::markdown::frontmatter::js_trim;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::provider::AiProvider;
use super::proxy::{AiProxy, Owner};
use super::settings::InlineAiSettings;
use super::structured::{self, Ask, Retry, StructuredError};

/// The longest body sent, in UTF-16 code units (`MAX_BODY_CHARS`).
const MAX_BODY_CHARS: usize = 24_000;
/// The most objects of a relation target matched against (`MAX_CANDIDATES`).
pub const MAX_CANDIDATES: usize = 50;

/// `FillFieldsSchema` of `@memry/contracts/tag-fill-api`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FillFieldsInput {
    pub note_id: String,
    /// Only this tag's group (its own and inherited fields); all field groups when absent.
    #[serde(default)]
    pub tag: Option<String>,
    /// The user accepted the first-run disclosure with this request.
    #[serde(default)]
    pub accept_disclosure: Option<bool>,
}

impl FillFieldsInput {
    /// The zod rules: a note id, and a tag that trims to 1 to 100 characters. The tag comes
    /// back trimmed.
    pub fn validate(mut self) -> Option<Self> {
        if self.note_id.is_empty() {
            return None;
        }
        if let Some(tag) = self.tag.take() {
            let tag = js_trim(&tag).to_owned();
            if !(1..=100).contains(&tag.encode_utf16().count()) {
                return None;
            }
            self.tag = Some(tag);
        }
        Some(self)
    }
}

/// A relation target no object matches: accepting creates a note with this title and tag.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct FillCreate {
    pub title: String,
    pub tag: String,
}

/// `FieldFillProposal`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldFillProposal {
    pub field: String,
    /// Ready for a property write; null for a relation whose target must be created first.
    pub value: Value,
    /// What the slot shows.
    pub display: String,
    /// The sentence of the note the value came from; '' when the model's quote is not in it.
    pub source_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub create: Option<FillCreate>,
}

/// `FillFieldsResult`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FillFieldsResult {
    Proposals { proposals: Vec<FieldFillProposal> },
    DisclosureRequired { model: String, local: bool },
    Unavailable,
    Failed { message: String },
}

/// `FieldFillStatus`: whether "Fill from note" shows, and what the disclosure names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldFillStatus {
    /// Inline AI is on with a configured provider.
    pub available: bool,
    pub model: String,
    /// The provider runs on this device (Ollama).
    pub local: bool,
    pub disclosure_accepted: bool,
}

/// `fieldFillStatus`.
pub fn status(settings: &InlineAiSettings, disclosure_accepted: bool) -> FieldFillStatus {
    let local = settings.provider == AiProvider::Ollama;
    let credentialed = match settings.provider {
        AiProvider::Custom => !settings.base_url.is_empty(),
        _ => local || !settings.api_key.is_empty(),
    };
    let configured = !js_trim(&settings.model).is_empty() && credentialed;
    FieldFillStatus {
        available: settings.enabled && configured,
        model: settings.model.clone(),
        local,
        disclosure_accepted,
    }
}

/// What a request may do before any note is read.
#[derive(Debug, Clone, PartialEq)]
pub enum Gate {
    /// Answer this and stop.
    Stop(FillFieldsResult),
    /// Go on; `accept` means the disclosure is to be recorded as accepted first.
    Go { accept: bool },
}

/// The start of `fillFields`: unavailable, the disclosure still to accept, or go.
pub fn gate(status: &FieldFillStatus, accept_disclosure: bool) -> Gate {
    if !status.available {
        return Gate::Stop(FillFieldsResult::Unavailable);
    }
    if status.disclosure_accepted {
        return Gate::Go { accept: false };
    }
    if !accept_disclosure {
        return Gate::Stop(FillFieldsResult::DisclosureRequired {
            model: status.model.clone(),
            local: status.local,
        });
    }
    Gate::Go { accept: true }
}

/// The note as the fill reads it.
#[derive(Debug, Clone, Default)]
pub struct FillNote {
    pub title: String,
    pub content: String,
    pub header_tags: Vec<String>,
    pub properties: Map<String, Value>,
}

fn is_filled(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !js_trim(text).is_empty(),
        Some(Value::Array(list)) => !list.is_empty(),
        Some(_) => true,
    }
}

/// `emptyFieldsOf`: the empty fields of the note's header tags, own and inherited, each once.
/// With `only`, just the header tags that are `only` or extend it.
pub fn empty_fields(
    note: &FillNote,
    resolved: &Resolved,
    only: Option<&str>,
) -> Vec<ResolvedField> {
    let only = only.map(tag_key);
    let mut seen = HashSet::new();
    let mut fields = Vec::new();
    for name in &note.header_tags {
        let Some(tag) = resolved.get(&tag_key(name)) else {
            continue;
        };
        if !tag.has_fields {
            continue;
        }
        if let Some(only) = &only
            && tag.key != *only
            && !tag.ancestors.contains(only)
        {
            continue;
        }
        for field in &tag.effective_fields {
            if !seen.insert(field.name.clone()) || is_filled(note.properties.get(&field.name)) {
                continue;
            }
            // A checkbox has no empty state the note can fill; a relation needs a target.
            let no_target = field.relation.as_ref().is_none_or(|r| r.target.is_none());
            if field.type_name == "checkbox" || (field.type_name == "relation" && no_target) {
                continue;
            }
            fields.push(field.clone());
        }
    }
    fields
}

/// What one fill asks the model, gathered off the async runtime.
#[derive(Debug, Clone)]
pub struct FillAsk {
    pub title: String,
    /// The trimmed body.
    pub body: String,
    pub fields: Vec<ResolvedField>,
    /// The objects of each relation target, by target key.
    pub candidates: HashMap<String, Vec<ObjectMatch>>,
}

/// The rest of `fillFields` before the model call: no note, no empty field or no body answers
/// no proposals. `objects_of` is the object search of a relation target.
pub fn plan<E>(
    note: Option<FillNote>,
    resolved: &Resolved,
    only: Option<&str>,
    mut objects_of: impl FnMut(&str) -> Result<Vec<ObjectMatch>, E>,
) -> Result<Option<FillAsk>, E> {
    let Some(note) = note else {
        return Ok(None);
    };
    let fields = empty_fields(&note, resolved, only);
    let body = js_trim(&note.content).to_owned();
    if fields.is_empty() || body.is_empty() {
        return Ok(None);
    }
    let mut candidates = HashMap::new();
    for field in &fields {
        let Some(target) = field.relation.as_ref().and_then(|r| r.target.as_deref()) else {
            continue;
        };
        if field.type_name != "relation" || candidates.contains_key(target) {
            continue;
        }
        let mut found = objects_of(target)?;
        found.truncate(MAX_CANDIDATES);
        candidates.insert(target.to_owned(), found);
    }
    Ok(Some(FillAsk {
        title: note.title,
        body,
        fields,
        candidates,
    }))
}

/// `describeField`.
fn describe(field: &ResolvedField) -> String {
    let mut parts = vec![format!("- \"{}\" ({})", field.name, field.type_name)];
    let options: Vec<String> = field
        .options
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| Some(format!("\"{}\"", option.get("value")?.as_str()?)))
        .collect();
    if !options.is_empty() {
        parts.push(format!("one of: {}", options.join(", ")));
    }
    match field.type_name.as_str() {
        "date" => parts.push("format YYYY-MM-DD".to_owned()),
        "number" => parts.push("the number as the note writes it".to_owned()),
        "relation" => {
            let target = field.relation.as_ref().and_then(|r| r.target.as_deref());
            parts.push(format!("the name of a #{}", target.unwrap_or_default()));
        }
        _ => {}
    }
    parts.join("; ")
}

/// The first `max` UTF-16 code units of `text` (`String.slice`), never splitting a character.
fn js_prefix(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &text[..at];
        }
    }
    text
}

const SYSTEM: &str = "You fill empty fields of a note from what the note itself says. Propose a value only when the note states it; never guess or invent. Leave out a field the note does not answer. Each value is plain text in the field's format. For a relation field give the name of the thing as the note writes it. sourceText is the one sentence of the note that states the value, copied character for character.";

/// The prompt of `ask`.
pub fn prompt(ask: &FillAsk) -> String {
    let mut lines = vec![format!("Title: {}", ask.title), "Fields:".to_owned()];
    lines.extend(ask.fields.iter().map(describe));
    lines.push(String::new());
    lines.push("Note:".to_owned());
    lines.push(js_prefix(&ask.body, MAX_BODY_CHARS).to_owned());
    lines.join("\n")
}

/// One proposal as the model writes it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawProposal {
    pub field: String,
    pub value: String,
    pub source_text: String,
}

#[derive(Deserialize)]
struct RawProposals {
    proposals: Vec<RawProposal>,
}

/// The model's proposals read against the fields: an unknown or repeated field and a value the
/// field cannot take are dropped, a quote not in the body is cleared, and the order is the
/// fields' order.
pub fn proposals(ask: &FillAsk, raw: Vec<RawProposal>, locale: &str) -> Vec<FieldFillProposal> {
    let by_name: HashMap<String, &ResolvedField> = ask
        .fields
        .iter()
        .map(|field| (field.name.to_lowercase(), field))
        .collect();
    let mut taken = HashSet::new();
    let mut out = Vec::new();
    for raw in raw {
        let Some(field) = by_name.get(&js_trim(&raw.field).to_lowercase()) else {
            continue;
        };
        if taken.contains(&field.name) {
            continue;
        }
        let target = field.relation.as_ref().and_then(|r| r.target.as_deref());
        let candidates = target
            .and_then(|target| ask.candidates.get(target))
            .map_or(&[][..], Vec::as_slice);
        let Some(mut proposal) = values::to_proposal(field, &raw.value, candidates, locale) else {
            continue;
        };
        taken.insert(field.name.clone());
        let source = js_trim(&raw.source_text);
        if !source.is_empty() && ask.body.contains(source) {
            proposal.source_text = source.to_owned();
        }
        out.push(proposal);
    }
    let position = |name: &str| ask.fields.iter().position(|field| field.name == name);
    out.sort_by_key(|proposal| position(&proposal.field));
    out
}

/// The model call of `fillFields`: its proposals for `ask`.
pub async fn run(
    proxy: &Arc<AiProxy>,
    settings: &InlineAiSettings,
    owner: &Owner,
    ask: &FillAsk,
    locale: &str,
    retry: Retry,
) -> Result<Vec<FieldFillProposal>, StructuredError> {
    tracing::info!(
        scope = "AI:FillFields",
        "Field fill request ({} fields)",
        ask.fields.len()
    );
    let prompt = prompt(ask);
    let request = Ask {
        system: SYSTEM,
        prompt: &prompt,
        schema: json!({
            "type": "object",
            "properties": {
                "proposals": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "field": { "type": "string" },
                            "value": { "type": "string" },
                            "sourceText": { "type": "string" },
                        },
                        "required": ["field", "value", "sourceText"],
                        "additionalProperties": false,
                    },
                },
            },
            "required": ["proposals"],
            "additionalProperties": false,
        }),
    };
    let raw: RawProposals = structured::generate(proxy, settings, owner, &request, retry).await?;
    Ok(proposals(ask, raw.proposals, locale))
}
