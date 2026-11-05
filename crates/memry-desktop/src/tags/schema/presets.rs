//! The ready-made tags (`tags/presets.ts`): the offers the tag hub shows, and adding one.

use std::collections::BTreeMap;

use memry_core::domain::tag_schema::{NewField, Relation, ResolvedTag, SchemaEdit};
use memry_core::domain::tags::tag_key;

use super::catalog::{self, CATALOG, PresetSpec};
use super::view::{ExistingTagView, PresetKey, PresetOfferFieldView, PresetOfferView, PresetState};
use super::{Effects, SchemaError, Schemas};
use crate::notes::property_definitions::OptionInput;
use crate::templates::TemplateCreateInput;
use crate::vault::consumer::rows::now_ms;

/// The tag that carries `preset` as its own (`ownerOf`).
fn owner_of(preset: PresetKey, resolved: &BTreeMap<String, ResolvedTag>) -> Option<String> {
    resolved
        .values()
        .find(|tag| tag.own_preset.as_deref() == Some(preset.as_str()))
        .map(|tag| tag.key.clone())
}

impl Schemas {
    /// The preset's tag name in the UI language, lowercase (`localizedTagName`).
    fn localized_name(&self, spec: &PresetSpec) -> String {
        tag_key(&self.t(spec.name_key).to_lowercase())
    }

    /// The relation targets adding `spec` creates too, and theirs (`missingTargets`).
    fn missing_targets(
        &self,
        spec: &PresetSpec,
        resolved: &BTreeMap<String, ResolvedTag>,
        seen: &mut Vec<PresetKey>,
    ) -> Vec<String> {
        let mut names = Vec::new();
        for field in spec.fields {
            let Some((target, _, _)) = field.relation else {
                continue;
            };
            if seen.contains(&target) || owner_of(target, resolved).is_some() {
                continue;
            }
            seen.push(target);
            let target_spec = catalog::spec(target);
            names.push(self.localized_name(target_spec));
            names.extend(self.missing_targets(target_spec, resolved, seen));
        }
        names
    }

    /// `presetOffers`: one offer per ready-made tag, in catalogue order.
    pub(super) fn offers(
        &self,
        resolved: &BTreeMap<String, ResolvedTag>,
        headers: &[(String, Vec<String>)],
    ) -> Result<Vec<PresetOfferView>, SchemaError> {
        let definitions = self.open.vault.tag_schema_definitions()?;
        let usage = |key: &str| {
            headers
                .iter()
                .filter(|(_, tags)| tags.iter().any(|tag| tag_key(tag) == key))
                .count() as u32
        };
        Ok(CATALOG
            .iter()
            .map(|spec| {
                let name = self.localized_name(spec);
                let owner = owner_of(spec.key, resolved);
                let existing = owner
                    .clone()
                    .or_else(|| definitions.contains_key(&name).then(|| name.clone()));
                let state = match (&owner, &existing) {
                    (Some(_), _) => PresetState::Added,
                    (None, Some(_)) => PresetState::AddFields,
                    (None, None) => PresetState::Add,
                };
                PresetOfferView {
                    key: spec.key,
                    icon: Some(spec.icon.to_owned()),
                    color: spec.color.to_owned(),
                    fields: spec
                        .fields
                        .iter()
                        .map(|field| PresetOfferFieldView {
                            name: self.t(field.name_key),
                            type_name: field.type_name,
                            relation_target: field.relation.map(|(target, _, _)| {
                                owner_of(target, resolved)
                                    .unwrap_or_else(|| self.localized_name(catalog::spec(target)))
                            }),
                        })
                        .collect(),
                    template_sections: spec.sections.iter().map(|(h, _)| self.t(h)).collect(),
                    state,
                    existing_tag: existing.map(|key| ExistingTagView {
                        usage: usage(&key),
                        key,
                    }),
                    also_adds: if owner.is_some() {
                        Vec::new()
                    } else {
                        self.missing_targets(spec, resolved, &mut vec![spec.key])
                    },
                    name,
                }
            })
            .collect())
    }

    /// `templateBody`: each section a heading, with its hint below it.
    fn template_body(&self, spec: &PresetSpec) -> String {
        let sections: Vec<String> = spec
            .sections
            .iter()
            .map(|(heading, hint)| match hint {
                Some(hint) => format!("## {}\n{}", self.t(heading), self.t(hint)),
                None => format!("## {}", self.t(heading)),
            })
            .collect();
        format!("{}\n", sections.join("\n\n"))
    }

    /// `addPreset`: the preset's fields (a relation's target preset first, unless a tag
    /// carries it already), the field definitions, the tag's colour and icon when it has none,
    /// a template unless the tag names its own, then the fields merged into the schema. A
    /// target that is being added further up (`person` and `meeting` name each other) is left
    /// open. Answers the tag written.
    pub(super) fn add_preset(
        &self,
        preset: PresetKey,
        explicit: Option<&str>,
        adding: &mut Vec<PresetKey>,
        effects: &mut Effects,
    ) -> Result<String, SchemaError> {
        let spec = catalog::spec(preset);
        let key = explicit.map_or_else(|| self.localized_name(spec), tag_key);
        adding.push(preset);

        let mut fields = Vec::new();
        for field in spec.fields {
            let name = self.field_name_for(&self.t(field.name_key))?;
            if let Some((target, many, inverse_key)) = field.relation {
                let target_tag = match owner_of(target, &self.resolved()?) {
                    Some(owner) => Some(owner),
                    None if adding.contains(&target) => None,
                    None => Some(self.add_preset(target, None, adding, effects)?),
                };
                fields.push(NewField {
                    name,
                    relation: Some(Relation {
                        target: target_tag,
                        many,
                        inverse: Some(self.t(inverse_key)),
                    }),
                });
                continue;
            }
            let options = field
                .options
                .iter()
                .map(|(value_key, color)| OptionInput {
                    value: self.t(value_key),
                    color: (*color).to_owned(),
                    default: None,
                })
                .collect();
            self.ensure_definition(
                &name,
                field.type_name,
                options,
                field.show_on_calendar,
                effects,
            )?;
            fields.push(NewField {
                name,
                relation: None,
            });
        }

        let definition = self.open.vault.tag_schema_definitions()?.remove(&key);
        if definition.is_none() {
            self.hub.set_color(&key, spec.color)?;
        }
        if definition.as_ref().is_none_or(|d| d.icon.is_none()) {
            self.hub.set_icon(&key, Some(spec.icon))?;
        }

        let own_template = self
            .resolved()?
            .get(&key)
            .and_then(|tag| tag.template.as_ref())
            .is_some_and(|template| template.inherited_from.is_none());
        let template = if own_template {
            None
        } else {
            let created = self.templates.create(
                &TemplateCreateInput {
                    name: self.t(spec.template_name_key),
                    content: self.template_body(spec),
                    ..TemplateCreateInput::default()
                },
                now_ms(),
            )?;
            effects.templates.push(created.id.clone());
            Some((created.id, true))
        };
        self.save(
            &key,
            &SchemaEdit::MergePreset {
                fields,
                template,
                preset: preset.as_str().to_owned(),
            },
        )?;
        Ok(key)
    }
}
