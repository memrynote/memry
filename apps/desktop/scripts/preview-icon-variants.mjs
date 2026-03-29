import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PREVIEW_DIR = join(__dirname, '..', 'build', 'previews')

const COLORS = {
  inbox: '#6366f1',
  journal: '#8b5cf6',
  task: '#d4944a',
  note: '#4a9e8e'
}

const SHARED_DEFS = `
    <linearGradient id="bg" x1="50" y1="10" x2="50" y2="90" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2a2a2a"/>
      <stop offset="1" stop-color="#111111"/>
    </linearGradient>
    <linearGradient id="topShine" x1="50" y1="10" x2="50" y2="30" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="borderGrad" x1="50" y1="10" x2="50" y2="90" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.15"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.3"/>
    </linearGradient>
    <filter id="logoShadow" x="-10%" y="-10%" width="130%" height="130%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="1.8" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
    <filter id="cardShadow" x="-5%" y="-5%" width="115%" height="118%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000000" flood-opacity="0.4"/>
    </filter>`

const SHARED_BASE = `
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="url(#bg)" filter="url(#cardShadow)"/>
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderGrad)" stroke-width="0.8"/>
  <rect x="10" y="10" width="80" height="20" rx="16" ry="16" fill="url(#topShine)"/>`

const LOGO = `
  <g transform="translate(10, 10) scale(0.8)" filter="url(#logoShadow)">
    <path d="M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70"
          stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M50 70 L50 85 L80 70"
          stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>`

function makeSvg(extraDefs, extraContent) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>${SHARED_DEFS}${extraDefs}
  </defs>
  ${SHARED_BASE}
  ${extraContent}
  ${LOGO}
</svg>`
}

// --- Variant 1: Conic sweep border ---
const V1_DEFS = `
    <linearGradient id="borderTop" x1="10" y1="10" x2="90" y2="10" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.note}"/>
      <stop offset="0.5" stop-color="${COLORS.inbox}"/>
      <stop offset="1" stop-color="${COLORS.journal}"/>
    </linearGradient>
    <linearGradient id="borderRight" x1="90" y1="10" x2="90" y2="90" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.journal}"/>
      <stop offset="1" stop-color="${COLORS.task}"/>
    </linearGradient>
    <linearGradient id="borderBottom" x1="90" y1="90" x2="10" y2="90" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.task}"/>
      <stop offset="0.5" stop-color="${COLORS.task}"/>
      <stop offset="1" stop-color="${COLORS.note}"/>
    </linearGradient>
    <linearGradient id="borderLeft" x1="10" y1="90" x2="10" y2="10" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.note}"/>
      <stop offset="1" stop-color="${COLORS.note}"/>
    </linearGradient>
    <mask id="topMask"><rect x="10" y="8" width="80" height="20" fill="white"/></mask>
    <mask id="rightMask"><rect x="70" y="10" width="22" height="80" fill="white"/></mask>
    <mask id="bottomMask"><rect x="10" y="72" width="80" height="20" fill="white"/></mask>
    <mask id="leftMask"><rect x="8" y="10" width="20" height="80" fill="white"/></mask>`

const V1_CONTENT = `
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderTop)" stroke-width="1.5" mask="url(#topMask)"/>
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderRight)" stroke-width="1.5" mask="url(#rightMask)"/>
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderBottom)" stroke-width="1.5" mask="url(#bottomMask)"/>
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderLeft)" stroke-width="1.5" mask="url(#leftMask)"/>`

// --- Variant 2: 4 corner gems ---
const V2_DEFS = `
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="1.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`

const V2_CONTENT = `
  <circle cx="16" cy="16" r="2.2" fill="${COLORS.inbox}" filter="url(#glow)" opacity="0.9"/>
  <circle cx="84" cy="16" r="2.2" fill="${COLORS.journal}" filter="url(#glow)" opacity="0.9"/>
  <circle cx="84" cy="84" r="2.2" fill="${COLORS.task}" filter="url(#glow)" opacity="0.9"/>
  <circle cx="16" cy="84" r="2.2" fill="${COLORS.note}" filter="url(#glow)" opacity="0.9"/>`

// --- Variant 3: 4 edge accents ---
const V3_DEFS = ``
const V3_CONTENT = `
  <line x1="35" y1="10.5" x2="65" y2="10.5" stroke="${COLORS.inbox}" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/>
  <line x1="89.5" y1="35" x2="89.5" y2="65" stroke="${COLORS.journal}" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/>
  <line x1="65" y1="89.5" x2="35" y2="89.5" stroke="${COLORS.task}" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/>
  <line x1="10.5" y1="65" x2="10.5" y2="35" stroke="${COLORS.note}" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/>`

// --- Variant 4: Bottom spectrum bar ---
const V4_DEFS = `
    <linearGradient id="spectrumBar" x1="18" y1="88" x2="82" y2="88" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.inbox}"/>
      <stop offset="0.33" stop-color="${COLORS.journal}"/>
      <stop offset="0.66" stop-color="${COLORS.task}"/>
      <stop offset="1" stop-color="${COLORS.note}"/>
    </linearGradient>
    <filter id="barGlow" x="-10%" y="-100%" width="120%" height="300%">
      <feGaussianBlur stdDeviation="1.2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="barClip">
      <rect x="10" y="10" width="80" height="80" rx="16" ry="16"/>
    </clipPath>`

const V4_CONTENT = `
  <g clip-path="url(#barClip)">
    <rect x="18" y="86.5" width="64" height="2.5" rx="1.2" fill="url(#spectrumBar)" filter="url(#barGlow)" opacity="0.9"/>
  </g>`

// --- Variant 5: Corner radial glows ---
const V5_DEFS = `
    <radialGradient id="glowInbox" cx="14" cy="14" r="18" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.inbox}" stop-opacity="0.25"/>
      <stop offset="1" stop-color="${COLORS.inbox}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowJournal" cx="86" cy="14" r="18" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.journal}" stop-opacity="0.25"/>
      <stop offset="1" stop-color="${COLORS.journal}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowTask" cx="86" cy="86" r="18" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.task}" stop-opacity="0.25"/>
      <stop offset="1" stop-color="${COLORS.task}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowNote" cx="14" cy="86" r="18" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.note}" stop-opacity="0.25"/>
      <stop offset="1" stop-color="${COLORS.note}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="cardClip">
      <rect x="10" y="10" width="80" height="80" rx="16" ry="16"/>
    </clipPath>`

const V5_CONTENT = `
  <g clip-path="url(#cardClip)">
    <rect x="10" y="10" width="40" height="40" fill="url(#glowInbox)"/>
    <rect x="50" y="10" width="40" height="40" fill="url(#glowJournal)"/>
    <rect x="50" y="50" width="40" height="40" fill="url(#glowTask)"/>
    <rect x="10" y="50" width="40" height="40" fill="url(#glowNote)"/>
  </g>`

// --- Variant 6: Quadrant tint shift ---
const V6_DEFS = `
    <linearGradient id="bgQ" x1="10" y1="10" x2="90" y2="90" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1a1a3a"/>
      <stop offset="0.35" stop-color="#1e1a2e"/>
      <stop offset="0.65" stop-color="#1a1a1a"/>
      <stop offset="1" stop-color="#1a2420"/>
    </linearGradient>
    <radialGradient id="tintInbox" cx="20" cy="20" r="35" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.inbox}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${COLORS.inbox}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="tintJournal" cx="80" cy="20" r="35" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.journal}" stop-opacity="0.10"/>
      <stop offset="1" stop-color="${COLORS.journal}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="tintTask" cx="80" cy="80" r="35" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.task}" stop-opacity="0.10"/>
      <stop offset="1" stop-color="${COLORS.task}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="tintNote" cx="20" cy="80" r="35" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.note}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${COLORS.note}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="cardClip6">
      <rect x="10" y="10" width="80" height="80" rx="16" ry="16"/>
    </clipPath>`

const V6_BASE = `
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="url(#bgQ)" filter="url(#cardShadow)"/>
  <g clip-path="url(#cardClip6)">
    <rect x="10" y="10" width="80" height="80" fill="url(#tintInbox)"/>
    <rect x="10" y="10" width="80" height="80" fill="url(#tintJournal)"/>
    <rect x="10" y="10" width="80" height="80" fill="url(#tintTask)"/>
    <rect x="10" y="10" width="80" height="80" fill="url(#tintNote)"/>
  </g>
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderGrad)" stroke-width="0.8"/>
  <rect x="10" y="10" width="80" height="20" rx="16" ry="16" fill="url(#topShine)"/>`

function makeSvgV6() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>${SHARED_DEFS}${V6_DEFS}
  </defs>
  ${V6_BASE}
  ${LOGO}
</svg>`
}

// --- 3D Logo definitions ---
const M_PATH = 'M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70'
const FOLD_PATH = 'M50 70 L50 85 L80 70'
const FOLD_FILL_PATH = 'M50 70 L50 85 L80 70 Z'

function make3dLogoSvg(borderDefs, borderContent, logoContent) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>${SHARED_DEFS}${borderDefs}
  </defs>
  ${SHARED_BASE}
  ${borderContent}
  ${logoContent}
</svg>`
}

// --- V1.1: Bolder M + bolder border ---
const V1_1_LOGO = `
  <g transform="translate(10, 10) scale(0.8)" filter="url(#logoShadow)">
    <path d="M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70"
          stroke="#FFFFFF" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M50 70 L50 85 L80 70"
          stroke="#FFFFFF" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>`

const V1_1_CONTENT = `
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderTop)" stroke-width="2.5" mask="url(#topMask)"/>
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderRight)" stroke-width="2.5" mask="url(#rightMask)"/>
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderBottom)" stroke-width="2.5" mask="url(#bottomMask)"/>
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderLeft)" stroke-width="2.5" mask="url(#leftMask)"/>`

// --- V7: Subtle emboss — light shadow + highlight edges ---
const V7_LOGO = `
  <g transform="translate(10, 10) scale(0.8)">
    <!-- Shadow layer (offset down+right) -->
    <path d="${M_PATH}" stroke="#000000" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.4" transform="translate(0.8, 1.5)"/>
    <path d="${FOLD_PATH}" stroke="#000000" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.4" transform="translate(0.8, 1.5)"/>

    <!-- Fold fill: paper face with gradient -->
    <path d="${FOLD_FILL_PATH}" fill="#2a2a2a" opacity="0.6"/>

    <!-- Main strokes -->
    <path d="${M_PATH}" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="${FOLD_PATH}" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>

    <!-- Top highlight (offset up) -->
    <path d="${M_PATH}" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.3" transform="translate(-0.3, -0.6)"/>
  </g>`

// --- V8: Medium depth — filled fold with gradient + stronger emboss ---
const V8_DEFS_EXTRA = `
    <linearGradient id="foldFace" x1="50" y1="70" x2="80" y2="85" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#555555"/>
      <stop offset="1" stop-color="#333333"/>
    </linearGradient>
    <linearGradient id="mStroke" x1="50" y1="25" x2="50" y2="85" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#CCCCCC"/>
    </linearGradient>
    <filter id="deepShadow" x="-15%" y="-15%" width="140%" height="140%">
      <feDropShadow dx="1" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.6"/>
    </filter>
    <filter id="foldShadow" x="-20%" y="-20%" width="150%" height="150%">
      <feDropShadow dx="0.5" dy="1.5" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
    <filter id="innerGlow" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="0.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`

const V8_LOGO = `
  <g transform="translate(10, 10) scale(0.8)">
    <!-- M shadow -->
    <path d="${M_PATH}" stroke="#000000" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.45" transform="translate(1, 2)"/>

    <!-- M main stroke with gradient (lit from top) -->
    <path d="${M_PATH}" stroke="url(#mStroke)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none" filter="url(#innerGlow)"/>

    <!-- M top-edge highlight -->
    <path d="${M_PATH}" stroke="#FFFFFF" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.4" transform="translate(-0.4, -0.7)"/>

    <!-- Fold: filled paper face -->
    <path d="${FOLD_FILL_PATH}" fill="url(#foldFace)" filter="url(#foldShadow)"/>

    <!-- Fold: crease line (dark edge where paper bends) -->
    <line x1="50" y1="70" x2="65" y2="77.5" stroke="#1a1a1a" stroke-width="1" opacity="0.6"/>

    <!-- Fold: stroke on top -->
    <path d="${FOLD_PATH}" stroke="url(#mStroke)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>

    <!-- Fold: highlight edge catching light -->
    <line x1="50" y1="84" x2="79" y2="70.5" stroke="#FFFFFF" stroke-width="0.8" stroke-linecap="round" opacity="0.3"/>
  </g>`

// --- V9: Heavy relief — thick bevel, dramatic fold, strong 3D ---
const V9_DEFS_EXTRA = `
    <linearGradient id="foldFace9" x1="55" y1="72" x2="75" y2="82" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4a4a4a"/>
      <stop offset="0.5" stop-color="#3a3a3a"/>
      <stop offset="1" stop-color="#252525"/>
    </linearGradient>
    <linearGradient id="foldHighlight" x1="50" y1="85" x2="80" y2="70" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.15"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="mStroke9" x1="50" y1="20" x2="50" y2="90" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.7" stop-color="#BBBBBB"/>
      <stop offset="1" stop-color="#999999"/>
    </linearGradient>
    <filter id="heavyShadow" x="-20%" y="-20%" width="150%" height="150%">
      <feDropShadow dx="1.2" dy="2.5" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.65"/>
    </filter>
    <filter id="foldShadow9" x="-25%" y="-25%" width="160%" height="160%">
      <feDropShadow dx="0.8" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.6"/>
    </filter>`

const V9_LOGO = `
  <g transform="translate(10, 10) scale(0.8)">
    <!-- M deep shadow -->
    <path d="${M_PATH}" stroke="#000000" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.35" transform="translate(1.2, 2.8)"/>

    <!-- M mid shadow (softer, wider) -->
    <path d="${M_PATH}" stroke="#000000" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.2" transform="translate(0.5, 1.2)"/>

    <!-- M main stroke with strong gradient -->
    <path d="${M_PATH}" stroke="url(#mStroke9)" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>

    <!-- M bright highlight edge -->
    <path d="${M_PATH}" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.5" transform="translate(-0.5, -0.8)"/>

    <!-- Fold: deep shadow first -->
    <path d="${FOLD_FILL_PATH}" fill="#000000" opacity="0.3" transform="translate(1, 2)" filter="url(#foldShadow9)"/>

    <!-- Fold: paper face with rich gradient -->
    <path d="${FOLD_FILL_PATH}" fill="url(#foldFace9)"/>

    <!-- Fold: light catching the fold face -->
    <path d="${FOLD_FILL_PATH}" fill="url(#foldHighlight)"/>

    <!-- Fold: crease shadow -->
    <line x1="50" y1="70" x2="65" y2="77.5" stroke="#0a0a0a" stroke-width="1.2" opacity="0.5"/>

    <!-- Fold: outer stroke -->
    <path d="${FOLD_PATH}" stroke="url(#mStroke9)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>

    <!-- Fold: specular highlight on bottom edge -->
    <line x1="52" y1="83.5" x2="78" y2="71" stroke="#FFFFFF" stroke-width="1" stroke-linecap="round" opacity="0.35"/>
  </g>`

const VARIANTS = [
  { name: 'v1-conic-sweep', svg: makeSvg(V1_DEFS, V1_CONTENT) },
  { name: 'v1.1-conic-sweep-bold', svg: make3dLogoSvg(V1_DEFS, V1_1_CONTENT, V1_1_LOGO) },
  { name: 'v2-corner-gems', svg: makeSvg(V2_DEFS, V2_CONTENT) },
  { name: 'v3-edge-accents', svg: makeSvg(V3_DEFS, V3_CONTENT) },
  { name: 'v4-bottom-spectrum', svg: makeSvg(V4_DEFS, V4_CONTENT) },
  { name: 'v5-corner-glows', svg: makeSvg(V5_DEFS, V5_CONTENT) },
  { name: 'v6-quadrant-tint', svg: makeSvgV6() },
  { name: 'v7-3d-subtle', svg: make3dLogoSvg(V1_DEFS, V1_CONTENT, V7_LOGO) },
  { name: 'v8-3d-medium', svg: make3dLogoSvg(V1_DEFS + V8_DEFS_EXTRA, V1_CONTENT, V8_LOGO) },
  { name: 'v9-3d-heavy', svg: make3dLogoSvg(V1_DEFS + V9_DEFS_EXTRA, V1_CONTENT, V9_LOGO) }
]

async function main() {
  mkdirSync(PREVIEW_DIR, { recursive: true })
  console.log('Generating 9 icon variants...\n')

  for (const { name, svg } of VARIANTS) {
    const buf = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer()
    writeFileSync(join(PREVIEW_DIR, `${name}.png`), buf)
    console.log(`  ${name}.png`)
  }

  console.log(`\nDone. Previews at: ${PREVIEW_DIR}`)
}

main().catch((err) => {
  console.error('Preview generation failed:', err)
  process.exit(1)
})
