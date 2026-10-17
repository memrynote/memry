// Real images already in the vault, so the cover picker's "From note" tab has something to offer:
// a Lisbon photo filed with Lisbon Ideas and two library references in Homepage Ideas. Lisbon
// Itinerary gets its cover on camera. The files are attached under ordinary names, the way Maya
// would have dropped them in.
// Photos, Unsplash License (free):
//   covers-lisbon-view.jpg       https://unsplash.com/photos/0Ot5ELyWJFk
//   covers-glass-library.jpg     https://unsplash.com/photos/qM24wXHcXfc
//   covers-library-interior.jpg  https://unsplash.com/photos/UtXSKc6afUY
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export default function ({ cli, assets }) {
  const byTitle = Object.fromEntries(
    cli('notes', 'list', '--limit', '500').map((n) => [n.title, n])
  )
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covers-'))
  const attach = (title, asset, name) => {
    const file = path.join(tmp, name)
    fs.copyFileSync(path.join(assets, asset), file)
    cli('notes', 'attach', byTitle[title].id, file)
  }
  attach('Homepage Ideas', 'covers-glass-library.jpg', 'library-facade.jpg')
  attach('Homepage Ideas', 'covers-library-interior.jpg', 'library-interior.jpg')
  attach('Lisbon Ideas', 'covers-lisbon-view.jpg', 'lisbon-rooftops.jpg')
  fs.rmSync(tmp, { recursive: true, force: true })
}
