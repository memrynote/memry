//! The ready-made tags (`tags/preset-catalog.ts`). Every string is a `notes:` key, read in the
//! UI language when an offer or a preset is made.

use super::view::{FieldType, PresetKey};

/// One field a preset adds.
pub(super) struct FieldSpec {
    pub name_key: &'static str,
    pub type_name: FieldType,
    /// `(value key, colour)` of a select's options.
    pub options: &'static [(&'static str, &'static str)],
    pub show_on_calendar: bool,
    /// `(target, many, inverse key)`.
    pub relation: Option<(PresetKey, bool, &'static str)>,
}

pub(super) struct PresetSpec {
    pub key: PresetKey,
    pub name_key: &'static str,
    pub icon: &'static str,
    pub color: &'static str,
    pub fields: &'static [FieldSpec],
    pub template_name_key: &'static str,
    /// `(heading key, hint key)`.
    pub sections: &'static [(&'static str, Option<&'static str>)],
}

const fn plain(name_key: &'static str, type_name: FieldType) -> FieldSpec {
    FieldSpec {
        name_key,
        type_name,
        options: &[],
        show_on_calendar: false,
        relation: None,
    }
}

const fn relation(
    name_key: &'static str,
    target: PresetKey,
    many: bool,
    inverse_key: &'static str,
) -> FieldSpec {
    FieldSpec {
        name_key,
        type_name: FieldType::Relation,
        options: &[],
        show_on_calendar: false,
        relation: Some((target, many, inverse_key)),
    }
}

macro_rules! key {
    ($rest:literal) => {
        concat!("notes:tagFields.presets.", $rest)
    };
}

pub(super) const CATALOG: [PresetSpec; 4] = [
    PresetSpec {
        key: PresetKey::Person,
        name_key: key!("person.name"),
        icon: "icon:UserIcon",
        color: "sky",
        fields: &[
            relation(
                key!("person.fields.company"),
                PresetKey::Company,
                false,
                key!("person.inverse.company"),
            ),
            plain(key!("person.fields.role"), FieldType::Text),
            plain(key!("person.fields.email"), FieldType::Text),
            plain(key!("person.fields.phone"), FieldType::Text),
        ],
        template_name_key: key!("person.template.name"),
        sections: &[
            (
                key!("person.template.context"),
                Some(key!("person.template.contextHint")),
            ),
            (key!("person.template.notes"), None),
        ],
    },
    PresetSpec {
        key: PresetKey::Company,
        name_key: key!("company.name"),
        icon: "icon:Building03Icon",
        color: "indigo",
        fields: &[
            plain(key!("company.fields.website"), FieldType::Url),
            plain(key!("company.fields.industry"), FieldType::Text),
            plain(key!("company.fields.location"), FieldType::Text),
        ],
        template_name_key: key!("company.template.name"),
        sections: &[
            (
                key!("company.template.overview"),
                Some(key!("company.template.overviewHint")),
            ),
            (key!("company.template.notes"), None),
        ],
    },
    PresetSpec {
        key: PresetKey::Meeting,
        name_key: key!("meeting.name"),
        icon: "icon:Calendar03Icon",
        color: "amber",
        fields: &[
            FieldSpec {
                name_key: key!("meeting.fields.date"),
                type_name: FieldType::Date,
                options: &[],
                show_on_calendar: true,
                relation: None,
            },
            relation(
                key!("meeting.fields.attendees"),
                PresetKey::Person,
                true,
                key!("meeting.inverse.attendees"),
            ),
            relation(
                key!("meeting.fields.company"),
                PresetKey::Company,
                false,
                key!("meeting.inverse.company"),
            ),
        ],
        template_name_key: key!("meeting.template.name"),
        sections: &[
            (key!("meeting.template.agenda"), None),
            (key!("meeting.template.notes"), None),
            (key!("meeting.template.actionItems"), None),
        ],
    },
    PresetSpec {
        key: PresetKey::Book,
        name_key: key!("book.name"),
        icon: "icon:BookOpen01Icon",
        color: "emerald",
        fields: &[
            plain(key!("book.fields.author"), FieldType::Text),
            FieldSpec {
                name_key: key!("book.fields.shelf"),
                type_name: FieldType::Select,
                options: &[
                    (key!("book.shelf.toRead"), "stone"),
                    (key!("book.shelf.reading"), "amber"),
                    (key!("book.shelf.read"), "green"),
                ],
                show_on_calendar: false,
                relation: None,
            },
            plain(key!("book.fields.rating"), FieldType::Number),
            plain(key!("book.fields.finished"), FieldType::Date),
        ],
        template_name_key: key!("book.template.name"),
        sections: &[
            (key!("book.template.highlights"), None),
            (key!("book.template.thoughts"), None),
        ],
    },
];

/// The catalogue lists the presets in `PresetKey`'s order.
pub(super) fn spec(key: PresetKey) -> &'static PresetSpec {
    &CATALOG[key as usize]
}
