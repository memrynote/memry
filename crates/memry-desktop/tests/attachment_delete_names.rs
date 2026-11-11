//! A ref the reference scan used to miss keeps the file (#4204). macOS stores a name in the
//! Unicode form it was written in, opens it by any other, and ignores case beyond ASCII; and a
//! template body is copied into every note made from it.
//!
//! | Test                                                               | Guard                      |
//! | ------------------------------------------------------------------ | -------------------------- |
//! | a ref in another Unicode form or non-ASCII case keeps the file     | the folded comparison      |
//! | a missing name that heals only once folded keeps the file          | the folded heal comparison |
//! | a template that names the file keeps it                            | the template scan          |

use std::fs;

use memry_desktop::templates::{TemplateCreateInput, Templates};

use crate::attachment_delete::{Vault, gone, kept_by};
use crate::device_key;

/// `café-Été.pdf` decomposed, as HFS+ and many macOS tools write it, with no stored prefix (a
/// ref with the prefix heals to it by the prefix alone).
const NFD: &str = "cafe\u{301}-E\u{301}te\u{301}.pdf";

fn with_file(name: &str, body: &str) -> Vault {
    let v = Vault::new("Other\n", &[]);
    fs::write(v.folder().join(name), b"bytes").unwrap();
    let body = body.replace("{owner}", &v.owner);
    fs::write(v.e.vault.join("Other.md"), body).unwrap();
    v
}

#[test]
fn a_ref_in_another_unicode_form_or_non_ascii_case_keeps_the_file() {
    for written in [
        "caf\u{e9}-\u{c9}t\u{e9}.pdf",
        "CAF\u{c9}-\u{c9}T\u{c9}.pdf",
        "caf%C3%A9-%C3%89t%C3%A9.pdf",
    ] {
        let v = with_file(NFD, &format!("![r](../attachments/{{owner}}/{written})\n"));
        let (outcome, trashed) = v.delete(NFD);
        assert_eq!(outcome.unwrap(), kept_by(&[&v.other]), "{written}");
        assert!(trashed.is_empty(), "{written}");
    }
}

/// A link to a name that is not on disk, whose name past the prefix is the file's once both are
/// folded: self-heal serves the file on a volume that folds them.
#[test]
fn a_missing_name_that_heals_only_once_folded_keeps_the_file() {
    let v = with_file(
        NFD,
        "![r](../attachments/{owner}/zzzzzz-CAF\u{c9}-\u{c9}T\u{c9}.pdf)\n",
    );
    let (outcome, trashed) = v.delete(NFD);
    assert_eq!(outcome.unwrap(), kept_by(&[&v.other]));
    assert!(trashed.is_empty());
}

#[test]
fn a_template_that_names_the_file_keeps_it() {
    let v = with_file(NFD, "Other\n");
    let templates = Templates::open(&v.open, device_key::with_device_key()).unwrap();
    let content = format!("![r](attachments/{}/{NFD})\n", v.owner);
    let template = templates
        .create(
            &TemplateCreateInput {
                name: "Keeps".into(),
                content,
                ..TemplateCreateInput::default()
            },
            1_760_000_000_000,
        )
        .unwrap();
    let (outcome, trashed) = v.delete(NFD);
    assert_eq!(outcome.unwrap(), kept_by(&[&template.id]));
    assert!(trashed.is_empty());
    templates.delete(&template.id, 1_760_000_000_001).unwrap();
    let (outcome, trashed) = v.delete(NFD);
    assert_eq!(outcome.unwrap(), gone());
    assert_eq!(trashed.len(), 1);
}
