import sharp from 'sharp'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..')

const LOGO_PATH = 'M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70'
const LOGO_TAIL = 'M50 70 L50 85 L80 70'

const WIDTH = 1200
const HEIGHT = 630

function optionA() {
  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="noise">
      <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feBlend in="SourceGraphic" mode="soft-light" result="blend"/>
    </filter>
    <radialGradient id="glow" cx="50%" cy="45%" r="50%">
      <stop offset="0%" stop-color="#c75b39" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="#fffcf7" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="100%" height="100%" fill="#fffcf7"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <rect width="100%" height="100%" filter="url(#noise)" opacity="0.3"/>

  <!-- Subtle top line accent -->
  <rect x="540" y="120" width="120" height="2" rx="1" fill="#c75b39" opacity="0.5"/>

  <!-- Memry. -->
  <text x="600" y="260" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="82" font-weight="400" fill="#1a1a1a"
        letter-spacing="4">Memry.</text>

  <!-- Thin separator -->
  <line x1="550" y1="290" x2="650" y2="290" stroke="#c75b39" stroke-width="1.5" opacity="0.4"/>

  <!-- Tagline -->
  <text x="600" y="340" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="28" font-weight="400" fill="#1a1a1a"
        font-style="italic" opacity="0.85">Your thoughts, beautifully organized.</text>

  <!-- Sub tagline -->
  <text x="600" y="390" text-anchor="middle"
        font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-size="17" fill="#6b6560" letter-spacing="0.5">Notes, tasks, and journal — finally in one place.</text>
  <text x="600" y="416" text-anchor="middle"
        font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-size="17" fill="#6b6560" letter-spacing="0.5">Private, fast, and yours forever.</text>

  <!-- Crown logo at bottom -->
  <g transform="translate(565, 460) scale(0.7)">
    <path d="${LOGO_PATH}" stroke="#c75b39" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.6"/>
    <path d="${LOGO_TAIL}" stroke="#c75b39" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.6"/>
  </g>

  <!-- Bottom border accent -->
  <rect x="0" y="626" width="1200" height="4" fill="#c75b39" opacity="0.15"/>
</svg>`
}

function optionD() {
  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="noise2">
      <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feBlend in="SourceGraphic" mode="soft-light" result="blend"/>
    </filter>
    <radialGradient id="darkglow" cx="50%" cy="40%" r="45%">
      <stop offset="0%" stop-color="#c75b39" stop-opacity="0.12"/>
      <stop offset="70%" stop-color="#111111" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="topfade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a1a1a"/>
      <stop offset="100%" stop-color="#111111"/>
    </linearGradient>
  </defs>

  <!-- Dark background -->
  <rect width="100%" height="100%" fill="url(#topfade)"/>
  <rect width="100%" height="100%" fill="url(#darkglow)"/>
  <rect width="100%" height="100%" filter="url(#noise2)" opacity="0.15"/>

  <!-- Crown logo centered above name -->
  <g transform="translate(556, 130) scale(0.9)">
    <path d="${LOGO_PATH}" stroke="#c75b39" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="${LOGO_TAIL}" stroke="#c75b39" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>

  <!-- Memry. large -->
  <text x="600" y="310" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="90" font-weight="400" fill="#fffcf7"
        letter-spacing="8">Memry.</text>

  <!-- Thin separator -->
  <line x1="530" y1="340" x2="670" y2="340" stroke="#c75b39" stroke-width="1.5" opacity="0.5"/>

  <!-- Tagline -->
  <text x="600" y="395" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="28" font-weight="400" fill="#fffcf7"
        font-style="italic" opacity="0.8">Your thoughts, beautifully organized.</text>

  <!-- Sub tagline -->
  <text x="600" y="445" text-anchor="middle"
        font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-size="16" fill="#fffcf7" opacity="0.45" letter-spacing="0.8">Notes, tasks, and journal — finally in one place.</text>
  <text x="600" y="471" text-anchor="middle"
        font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-size="16" fill="#fffcf7" opacity="0.45" letter-spacing="0.8">Private, fast, and yours forever.</text>

  <!-- Subtle bottom accent line -->
  <rect x="0" y="0" width="1200" height="3" fill="#c75b39" opacity="0.3"/>
  <rect x="0" y="627" width="1200" height="3" fill="#c75b39" opacity="0.3"/>
</svg>`
}

async function generate() {
  const svgA = Buffer.from(optionA())
  const svgD = Buffer.from(optionD())

  await Promise.all([
    sharp(svgA)
      .jpeg({ quality: 92 })
      .toFile(join(outDir, 'hero-light.jpg')),
    sharp(svgD)
      .jpeg({ quality: 92 })
      .toFile(join(outDir, 'hero-dark.jpg')),
  ])

  console.log('Generated: hero-light.jpg (Option A)')
  console.log('Generated: hero-dark.jpg (Option D)')
}

generate().catch(console.error)
