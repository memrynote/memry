// Generates desktop_yjs_body.json with desktop's yjs, for
// tests/sync_body_apply_races.rs (#5231). The test reads only the JSON, so
// cargo test needs no node. Regenerate from the repo root:
//   node crates/memry-core/tests/fixtures/desktop_yjs_body.gen.mjs
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../../../apps/desktop/package.json', import.meta.url))
const Y = require('yjs')

const hex = (bytes) => Buffer.from(bytes).toString('hex')
const doc = new Y.Doc()
doc.clientID = 4242
const text = doc.getText('t')
const captured = []
doc.on('update', (update) => captured.push(update))

text.insert(0, 'Desktop snapshot body. ')
const snapshot = Y.encodeStateAsUpdate(doc)
captured.length = 0
for (let i = 0; i < 105; i++) {
  if (i % 7 === 3) text.delete(2, 1)
  else text.insert(text.length, 'w' + i + ' ')
}
const updates = captured.map(hex)
captured.length = 0
// The edit desktop makes after the core holds everything above.
text.insert(5, '[EDITED ON DESKTOP]')
const edit = hex(captured[0])

fs.writeFileSync(
  new URL('./desktop_yjs_body.json', import.meta.url),
  JSON.stringify(
    {
      snapshot: hex(snapshot),
      updates,
      edit,
      text: text.toJSON(),
      state: hex(Y.encodeStateAsUpdate(doc)),
      sv: hex(Y.encodeStateVector(doc))
    },
    null,
    2
  ) + '\n'
)
