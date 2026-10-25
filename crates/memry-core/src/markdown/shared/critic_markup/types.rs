//! The CriticMarkup data model of `parser.ts`. Offsets (`start`, `end`, and
//! the format ranges) count UTF-16 code units, as the TypeScript does.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CriticMarkupKind {
    Addition,
    Deletion,
    Substitution,
    Comment,
}

impl CriticMarkupKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Addition => "addition",
            Self::Deletion => "deletion",
            Self::Substitution => "substitution",
            Self::Comment => "comment",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriticMarkupCommentMentionKind {
    Note,
    Task,
    Journal,
    Inbox,
    CalendarEvent,
}

impl CriticMarkupCommentMentionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Task => "task",
            Self::Journal => "journal",
            Self::Inbox => "inbox",
            Self::CalendarEvent => "calendar_event",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "note" => Some(Self::Note),
            "task" => Some(Self::Task),
            "journal" => Some(Self::Journal),
            "inbox" => Some(Self::Inbox),
            "calendar_event" => Some(Self::CalendarEvent),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CriticMarkupCommentMentionRef {
    pub kind: CriticMarkupCommentMentionKind,
    #[serde(rename = "refId")]
    pub ref_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CriticMarkupAttachmentType {
    Image,
    File,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CriticMarkupCommentAttachmentRef {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    #[serde(default, rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub attachment_type: Option<CriticMarkupAttachmentType>,
}

/// Declaration order is the canonical mark order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CriticMarkupCommentFormatMark {
    Bold,
    Italic,
    Underline,
    Strikethrough,
    Code,
}

/// The canonical mark order, outermost first when rendered.
pub const CRITIC_MARKUP_COMMENT_FORMAT_MARKS: [CriticMarkupCommentFormatMark; 5] = [
    CriticMarkupCommentFormatMark::Bold,
    CriticMarkupCommentFormatMark::Italic,
    CriticMarkupCommentFormatMark::Underline,
    CriticMarkupCommentFormatMark::Strikethrough,
    CriticMarkupCommentFormatMark::Code,
];

impl CriticMarkupCommentFormatMark {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bold => "bold",
            Self::Italic => "italic",
            Self::Underline => "underline",
            Self::Strikethrough => "strikethrough",
            Self::Code => "code",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        CRITIC_MARKUP_COMMENT_FORMAT_MARKS
            .into_iter()
            .find(|mark| mark.as_str() == value)
    }
}

/// Inline formatting for a slice of a comment body, as UTF-16 offsets into it.
/// `end` is exclusive. Offsets are JS numbers, so they stay `f64`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CriticMarkupCommentFormatRange {
    pub start: f64,
    pub end: f64,
    pub marks: Vec<CriticMarkupCommentFormatMark>,
}

/// Field order is the key order of the objects `parseCriticMarkup` builds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CriticMarkupMark {
    pub id: String,
    pub kind: CriticMarkupKind,
    #[serde(rename = "visibleText")]
    pub visible_text: String,
    #[serde(
        default,
        rename = "originalText",
        skip_serializing_if = "Option::is_none"
    )]
    pub original_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
    #[serde(default, rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<CriticMarkupCommentMentionRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<CriticMarkupCommentAttachmentRef>>,
    #[serde(
        default,
        rename = "formatRanges",
        skip_serializing_if = "Option::is_none"
    )]
    pub format_ranges: Option<Vec<CriticMarkupCommentFormatRange>>,
    /// UTF-16 offset into the plain text.
    pub start: i64,
    /// UTF-16 offset into the plain text, exclusive.
    pub end: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedCriticMarkup {
    #[serde(rename = "plainText")]
    pub plain_text: String,
    pub marks: Vec<CriticMarkupMark>,
}
