// A Lisbon viewpoint photo in Lisbon Ideas, the image the clip crops and resizes.
// Photo, Unsplash License (free): image-crop-miradouro.jpg  https://unsplash.com/photos/HJNHne9EGFE
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export default function ({ cli, assets }) {
  const ideas = cli('notes', 'list', '--limit', '500').find((n) => n.title === 'Lisbon Ideas')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-crop-'))
  const file = path.join(tmp, 'miradouro.jpg')
  fs.copyFileSync(path.join(assets, 'image-crop-miradouro.jpg'), file)
  cli('notes', 'attach', ideas.id, file)
  fs.rmSync(tmp, { recursive: true, force: true })
}
