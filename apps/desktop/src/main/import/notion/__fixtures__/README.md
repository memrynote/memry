# Notion importer test fixtures

`notion-export.zip` is a **synthetic** Notion HTML export used by the importer tests.

It is hand-authored (not a real user export) so it can be committed without leaking
personal data, and so tests can assert exact titles/ids. The real sample export at the
repo root was a **Markdown** export (`.md`/`.csv`), which this importer does not consume.

## Structure (nested, like a real Notion export)

```
notion-export.zip
└── Export-fixture-Part-1.zip          # nested zip — exercises recursion
    ├── index.html                     # export summary — importer skips it
    ├── Parent Page <id1>.html         # parent page: heading, internal link, to-dos, image
    ├── Parent Page <id1>/
    │   ├── Child Page <id2>.html       # nested child page (folder nesting)
    │   └── cat.png                     # attachment (1x1 PNG) referenced by the parent
    └── Tasks DB <id3>.html             # page with a multi_select "Tags" property
```

ids: `id1 = 1×32`, `id2 = 2×32`, `id3 = 3×32`.

## Rebuild recipe

```bash
# author the html tree under build/htmlroot/ (see git history for contents), then:
( cd build/htmlroot && zip -q -r -X ../Export-fixture-Part-1.zip . )
( cd build && zip -q -X ../notion-export.zip Export-fixture-Part-1.zip )
```
