"""Writes index.db: Electron's vec_notes, made by Electron's own sqlite-vec build.

Electron ships sqlite-vec 0.1.7-alpha.2 (apps/desktop/package.json); the core reads with the
sqlite-vec crate. The table is created with Electron's DDL (client.ts ensureVecNotesTable) and
holds three vectors Electron's text path stored (packages/contracts/test-vectors/
embeddings-text.json, texts 0-2), as Float32Array bytes, under the note ids the import test
seeds. Run from the repo root after `pnpm install`:

    python3 crates/memry-desktop/tests/fixtures/electron-vectors/generate.py \
        node_modules/.pnpm/sqlite-vec-darwin-arm64@0.1.7-alpha.2/node_modules/sqlite-vec-darwin-arm64/vec0
"""

import json
import os
import sqlite3
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NOTES = ["Vec-kept0001", "Vec-edit0001", "Vec-dirty001"]

texts = json.load(open("packages/contracts/test-vectors/embeddings-text.json"))["texts"]
out = os.path.join(HERE, "index.db")
if os.path.exists(out):
    os.remove(out)
db = sqlite3.connect(out)
db.enable_load_extension(True)
db.load_extension(sys.argv[1])
assert db.execute("SELECT vec_version()").fetchone()[0] == "v0.1.7-alpha.2"
db.execute(
    """CREATE VIRTUAL TABLE IF NOT EXISTS vec_notes USING vec0(
      note_id TEXT PRIMARY KEY,
      embedding float[256] distance_metric=cosine
    )"""
)
for note_id, text in zip(NOTES, texts):
    vector = text["embedding"]
    assert len(vector) == 256
    db.execute(
        "INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)",
        (note_id, struct.pack("<256f", *vector)),
    )
db.commit()
db.close()
