// A receipt screenshot and a warranty PDF, filed under Receipts with the names they arrived with.
// Neither name says "monitor"; only the text inside them does.
import * as fs from 'node:fs'
import * as path from 'node:path'

export default function ({ cli, write, assets }) {
  cli('folders', 'create', 'Receipts')
  write(
    'Receipts/Screenshot 2026-03-14 at 18.41.png',
    fs.readFileSync(path.join(assets, 'pdf-search-receipt.png'))
  )
  write('Receipts/document (3).pdf', fs.readFileSync(path.join(assets, 'pdf-search-warranty.pdf')))
}
