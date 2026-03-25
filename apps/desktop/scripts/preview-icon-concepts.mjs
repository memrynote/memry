import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'build', 'concepts')

const C = { inbox: '#6366f1', journal: '#8b5cf6', task: '#d4944a', note: '#4a9e8e' }

const DEFS = `
    <linearGradient id="bg" x1="50" y1="10" x2="50" y2="90" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2a2a2a"/><stop offset="1" stop-color="#111111"/>
    </linearGradient>
    <linearGradient id="topShine" x1="50" y1="10" x2="50" y2="30" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0.12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="borderGrad" x1="50" y1="10" x2="50" y2="90" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0.15"/><stop offset="1" stop-color="#000" stop-opacity="0.3"/>
    </linearGradient>
    <filter id="shadow" x="-5%" y="-5%" width="115%" height="118%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000" flood-opacity="0.4"/>
    </filter>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="logoSh" x="-10%" y="-10%" width="130%" height="130%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="1.8" flood-color="#000" flood-opacity="0.55"/>
    </filter>`

const CARD = `
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="url(#bg)" filter="url(#shadow)"/>
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="none" stroke="url(#borderGrad)" stroke-width="0.8"/>
  <rect x="10" y="10" width="80" height="20" rx="16" ry="16" fill="url(#topShine)"/>`

function svg(extraDefs, content) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>${DEFS}${extraDefs}</defs>
  ${CARD}
  ${content}
</svg>`
}

// --- C01: Neural Network M ---
const c01 = svg(
  '',
  `
  <g transform="translate(10,10) scale(0.8)">
    <path d="M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70"
          stroke="rgba(255,255,255,0.25)" stroke-width="1.5" fill="none"/>
    <path d="M50 70 L50 85 L80 70"
          stroke="rgba(255,255,255,0.25)" stroke-width="1.5" fill="none"/>
    <line x1="20" y1="30" x2="65" y2="45" stroke="rgba(255,255,255,0.1)" stroke-width="0.8"/>
    <line x1="35" y1="45" x2="80" y2="30" stroke="rgba(255,255,255,0.1)" stroke-width="0.8"/>
    <line x1="35" y1="45" x2="50" y2="70" stroke="rgba(255,255,255,0.1)" stroke-width="0.8"/>
    <line x1="65" y1="45" x2="50" y2="70" stroke="rgba(255,255,255,0.1)" stroke-width="0.8"/>
    <line x1="20" y1="70" x2="50" y2="25" stroke="rgba(255,255,255,0.06)" stroke-width="0.6"/>
    <line x1="80" y1="70" x2="50" y2="25" stroke="rgba(255,255,255,0.06)" stroke-width="0.6"/>
    <circle cx="20" cy="70" r="4.5" fill="${C.note}" filter="url(#glow)"/>
    <circle cx="20" cy="30" r="4" fill="${C.inbox}" filter="url(#glow)"/>
    <circle cx="35" cy="45" r="3" fill="${C.inbox}" filter="url(#glow)" opacity="0.8"/>
    <circle cx="50" cy="25" r="5" fill="${C.journal}" filter="url(#glow)"/>
    <circle cx="65" cy="45" r="3" fill="${C.journal}" filter="url(#glow)" opacity="0.8"/>
    <circle cx="80" cy="30" r="4" fill="${C.task}" filter="url(#glow)"/>
    <circle cx="80" cy="70" r="4.5" fill="${C.task}" filter="url(#glow)"/>
    <circle cx="50" cy="70" r="3" fill="${C.note}" filter="url(#glow)" opacity="0.7"/>
    <circle cx="50" cy="85" r="3" fill="${C.note}" filter="url(#glow)" opacity="0.7"/>
  </g>`
)

// --- C02: Origami M ---
const c02 = svg(
  '',
  `
  <g transform="translate(10,10) scale(0.8)">
    <polygon points="20,70 20,30 35,45" fill="#5a8a7e"/>
    <polygon points="20,30 35,45 50,25" fill="#6a70a5"/>
    <polygon points="35,45 50,25 65,45" fill="#7a6a9a"/>
    <polygon points="50,25 65,45 80,30" fill="#7070a0"/>
    <polygon points="65,45 80,30 80,70" fill="#8a7a55"/>
    <polygon points="20,70 35,45 50,70" fill="#3a5550"/>
    <polygon points="35,45 65,45 50,70" fill="#303838"/>
    <polygon points="65,45 80,70 50,70" fill="#504a38"/>
    <polygon points="50,70 50,85 80,70" fill="#1e2020"/>
    <path d="M20,70 L20,30 L35,45 L50,25 L65,45 L80,30 L80,70 L50,70 Z"
          stroke="#fff" stroke-width="0.8" fill="none" opacity="0.5"/>
    <line x1="35" y1="45" x2="50" y2="70" stroke="#fff" stroke-width="0.5" opacity="0.35"/>
    <line x1="65" y1="45" x2="50" y2="70" stroke="#fff" stroke-width="0.5" opacity="0.35"/>
    <line x1="35" y1="45" x2="65" y2="45" stroke="#fff" stroke-width="0.5" opacity="0.3"/>
    <line x1="20" y1="30" x2="50" y2="25" stroke="#fff" stroke-width="0.5" opacity="0.3"/>
    <line x1="50" y1="25" x2="80" y2="30" stroke="#fff" stroke-width="0.5" opacity="0.3"/>
    <path d="M50,70 L50,85 L80,70 Z" stroke="#fff" stroke-width="0.6" fill="none" opacity="0.4"/>
  </g>`
)

// --- C03: Memory Palace Door ---
const c03 = svg(
  `
    <radialGradient id="warmGlow" cx="50" cy="60" r="22" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffd700" stop-opacity="0.3"/>
      <stop offset="0.6" stop-color="#ff8c00" stop-opacity="0.1"/>
      <stop offset="1" stop-opacity="0"/>
    </radialGradient>`,
  `
  <g transform="translate(10,10) scale(0.8)">
    <ellipse cx="50" cy="60" rx="20" ry="25" fill="url(#warmGlow)"/>
    <path d="M28,85 L28,45 A22,14 0 0 1 72,45 L72,85"
          fill="none" stroke="#777" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M32,85 L32,47 A18,11 0 0 1 68,47 L68,85"
          fill="rgba(0,0,0,0.2)" stroke="none"/>
    <g transform="translate(30,42) scale(0.4)" filter="url(#logoSh)">
      <path d="M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70"
            stroke="#ddd" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M50 70 L50 85 L80 70"
            stroke="#ddd" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </g>
    <line x1="18" y1="85" x2="82" y2="85" stroke="#555" stroke-width="0.8"/>
  </g>`
)

// --- C04: Stacked Layers ---
const c04 = svg(
  '',
  `
  <g transform="translate(10,10) scale(0.8)">
    <rect x="20" y="33" width="60" height="52" rx="6" fill="#1a1a1a" stroke="${C.note}" stroke-width="1.2"/>
    <rect x="20" y="28" width="60" height="52" rx="6" fill="#1e1e1e" stroke="${C.task}" stroke-width="1.2"/>
    <rect x="20" y="23" width="60" height="52" rx="6" fill="#222" stroke="${C.journal}" stroke-width="1.2"/>
    <rect x="20" y="18" width="60" height="52" rx="6" fill="#282828" stroke="${C.inbox}" stroke-width="1.2"/>
    <g transform="translate(20,18) scale(0.6)" filter="url(#logoSh)">
      <path d="M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70"
            stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M50 70 L50 85 L80 70"
            stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </g>
  </g>`
)

// --- C05: Constellation M ---
const c05 = svg(
  `
    <radialGradient id="nebula" cx="50" cy="45" r="35" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.journal}" stop-opacity="0.08"/>
      <stop offset="0.5" stop-color="${C.inbox}" stop-opacity="0.04"/>
      <stop offset="1" stop-opacity="0"/>
    </radialGradient>
    <filter id="starGlow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="1.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`,
  `
  <g transform="translate(10,10) scale(0.8)">
    <rect x="0" y="0" width="100" height="100" fill="url(#nebula)"/>
    <circle cx="12" cy="15" r="0.4" fill="#fff" opacity="0.25"/>
    <circle cx="88" cy="20" r="0.3" fill="#fff" opacity="0.2"/>
    <circle cx="8" cy="50" r="0.5" fill="#fff" opacity="0.15"/>
    <circle cx="92" cy="55" r="0.35" fill="#fff" opacity="0.2"/>
    <circle cx="45" cy="8" r="0.4" fill="#fff" opacity="0.2"/>
    <circle cx="60" cy="95" r="0.35" fill="#fff" opacity="0.18"/>
    <circle cx="90" cy="88" r="0.4" fill="#fff" opacity="0.15"/>
    <circle cx="15" cy="90" r="0.3" fill="#fff" opacity="0.22"/>
    <circle cx="30" cy="12" r="0.3" fill="#fff" opacity="0.18"/>
    <circle cx="75" cy="10" r="0.35" fill="#fff" opacity="0.2"/>
    <circle cx="5" cy="75" r="0.3" fill="#fff" opacity="0.15"/>
    <circle cx="95" cy="42" r="0.4" fill="#fff" opacity="0.12"/>
    <circle cx="42" cy="60" r="0.3" fill="#fff" opacity="0.1"/>
    <circle cx="70" cy="75" r="0.4" fill="#fff" opacity="0.12"/>
    <path d="M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70"
          stroke="rgba(255,255,255,0.15)" stroke-width="0.6" stroke-dasharray="2,1" fill="none"/>
    <path d="M50 70 L50 85 L80 70"
          stroke="rgba(255,255,255,0.15)" stroke-width="0.6" stroke-dasharray="2,1" fill="none"/>
    <circle cx="50" cy="25" r="3" fill="#fff" filter="url(#starGlow)" opacity="0.9"/>
    <circle cx="20" cy="30" r="2.5" fill="${C.inbox}" filter="url(#starGlow)"/>
    <circle cx="80" cy="30" r="2.5" fill="${C.task}" filter="url(#starGlow)"/>
    <circle cx="20" cy="70" r="2" fill="${C.note}" filter="url(#starGlow)" opacity="0.7"/>
    <circle cx="80" cy="70" r="2" fill="${C.task}" filter="url(#starGlow)" opacity="0.7"/>
    <circle cx="35" cy="45" r="1.5" fill="#fff" filter="url(#starGlow)" opacity="0.5"/>
    <circle cx="65" cy="45" r="1.5" fill="#fff" filter="url(#starGlow)" opacity="0.5"/>
    <circle cx="50" cy="70" r="1.2" fill="${C.note}" filter="url(#starGlow)" opacity="0.5"/>
    <circle cx="50" cy="85" r="1.2" fill="${C.note}" filter="url(#starGlow)" opacity="0.5"/>
  </g>`
)

// --- C06: Infinity-M ---
const c06 = svg(
  '',
  `
  <g transform="translate(10,10) scale(0.8)" filter="url(#logoSh)">
    <line x1="22" y1="75" x2="22" y2="30" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
    <line x1="78" y1="75" x2="78" y2="30" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
    <line x1="22" y1="30" x2="36" y2="52" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
    <line x1="78" y1="30" x2="64" y2="52" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
    <line x1="22" y1="75" x2="78" y2="75" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
    <path d="M50,52 C50,38 36,38 36,52 C36,66 50,66 50,52 C50,66 64,66 64,52 C64,38 50,38 50,52"
          stroke="#fff" stroke-width="5" fill="none" stroke-linejoin="round"/>
  </g>`
)

// --- C07: Gem / Crystal M ---
const c07 = svg(
  `
    <linearGradient id="g1" x1="20" y1="30" x2="35" y2="70" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.note}"/><stop offset="1" stop-color="${C.note}" stop-opacity="0.4"/>
    </linearGradient>
    <linearGradient id="g2" x1="20" y1="25" x2="50" y2="45" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.inbox}"/><stop offset="1" stop-color="${C.inbox}" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="g3" x1="35" y1="25" x2="65" y2="45" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.journal}"/><stop offset="1" stop-color="${C.journal}" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="g4" x1="50" y1="25" x2="80" y2="45" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.journal}" stop-opacity="0.7"/><stop offset="1" stop-color="${C.inbox}" stop-opacity="0.4"/>
    </linearGradient>
    <linearGradient id="g5" x1="65" y1="30" x2="80" y2="70" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.task}"/><stop offset="1" stop-color="${C.task}" stop-opacity="0.4"/>
    </linearGradient>`,
  `
  <g transform="translate(10,10) scale(0.8)">
    <polygon points="20,70 20,30 35,45" fill="url(#g1)"/>
    <polygon points="20,30 35,45 50,25" fill="url(#g2)"/>
    <polygon points="35,45 50,25 65,45" fill="url(#g3)"/>
    <polygon points="50,25 65,45 80,30" fill="url(#g4)"/>
    <polygon points="65,45 80,30 80,70" fill="url(#g5)"/>
    <polygon points="20,70 35,45 50,70" fill="${C.note}" opacity="0.25"/>
    <polygon points="35,45 65,45 50,70" fill="${C.journal}" opacity="0.2"/>
    <polygon points="65,45 80,70 50,70" fill="${C.task}" opacity="0.25"/>
    <polygon points="50,70 50,85 80,70" fill="#1a1a1e" opacity="0.7"/>
    <path d="M20,70 L20,30 L35,45 L50,25 L65,45 L80,30 L80,70 L50,70 Z"
          stroke="#fff" stroke-width="1.2" fill="none" opacity="0.7"/>
    <line x1="35" y1="45" x2="50" y2="70" stroke="#fff" stroke-width="0.8" opacity="0.5"/>
    <line x1="65" y1="45" x2="50" y2="70" stroke="#fff" stroke-width="0.8" opacity="0.5"/>
    <line x1="35" y1="45" x2="65" y2="45" stroke="#fff" stroke-width="0.8" opacity="0.5"/>
    <path d="M50,70 L50,85 L80,70 Z" stroke="#fff" stroke-width="0.8" fill="none" opacity="0.5"/>
    <circle cx="50" cy="25" r="2.5" fill="#fff" opacity="0.6" filter="url(#glow)"/>
    <circle cx="33" cy="38" r="1" fill="#fff" opacity="0.4"/>
    <circle cx="70" cy="35" r="1.2" fill="#fff" opacity="0.35"/>
    <line x1="48" y1="23" x2="52" y2="23" stroke="#fff" stroke-width="1.2" opacity="0.7" stroke-linecap="round"/>
    <line x1="50" y1="21" x2="50" y2="27" stroke="#fff" stroke-width="1.2" opacity="0.7" stroke-linecap="round"/>
  </g>`
)

// --- C08: Seal / Stamp ---
function sealEdge(cx, cy, outer, inner, n) {
  const pts = []
  for (let i = 0; i < n * 2; i++) {
    const a = (i * Math.PI) / n - Math.PI / 2
    const r = i % 2 === 0 ? outer : inner
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`)
  }
  return `M${pts.join(' L')} Z`
}

const c08 = svg(
  '',
  `
  <g transform="translate(10,10) scale(0.8)">
    <path d="${sealEdge(50, 52, 37, 33, 24)}" fill="none" stroke="#999" stroke-width="1.2" opacity="0.6"/>
    <circle cx="50" cy="52" r="30" fill="none" stroke="#777" stroke-width="0.6" opacity="0.4"/>
    <circle cx="50" cy="52" r="26" fill="none" stroke="#666" stroke-width="0.4" opacity="0.3"/>
    <g transform="translate(26,28) scale(0.48)" filter="url(#logoSh)">
      <path d="M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70"
            stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M50 70 L50 85 L80 70"
            stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </g>
  </g>`
)

// --- C09: Brainwave M ---
const c09 = svg(
  '',
  `
  <g transform="translate(10,10) scale(0.8)">
    <line x1="8" y1="62" x2="92" y2="62" stroke="#444" stroke-width="0.8" stroke-dasharray="2,2"/>
    <path d="M5,62 C10,62 16,62 20,30 C24,10 30,58 35,50 C40,42 44,18 50,22 C56,26 60,58 65,50 C70,42 76,10 80,30 C84,62 90,62 95,62"
          stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <circle cx="20" cy="30" r="2.5" fill="${C.inbox}" filter="url(#glow)"/>
    <circle cx="50" cy="22" r="3" fill="${C.journal}" filter="url(#glow)"/>
    <circle cx="80" cy="30" r="2.5" fill="${C.task}" filter="url(#glow)"/>
  </g>`
)

// --- C10: Book ---
const c10 = svg(
  '',
  `
  <g transform="translate(10,10) scale(0.8)">
    <path d="M50,22 C42,22 22,22 20,25 L20,82 C22,79 42,79 50,80" fill="#2d2d2d" stroke="#444" stroke-width="0.5"/>
    <path d="M50,22 C58,22 78,22 80,25 L80,82 C78,79 58,79 50,80" fill="#323232" stroke="#444" stroke-width="0.5"/>
    <line x1="50" y1="22" x2="50" y2="80" stroke="#222" stroke-width="2"/>
    <line x1="50" y1="22" x2="50" y2="80" stroke="#444" stroke-width="0.5"/>
    <line x1="28" y1="36" x2="46" y2="36" stroke="#444" stroke-width="0.3" opacity="0.4"/>
    <line x1="28" y1="42" x2="46" y2="42" stroke="#444" stroke-width="0.3" opacity="0.4"/>
    <line x1="28" y1="48" x2="46" y2="48" stroke="#444" stroke-width="0.3" opacity="0.4"/>
    <line x1="28" y1="54" x2="46" y2="54" stroke="#444" stroke-width="0.3" opacity="0.4"/>
    <line x1="54" y1="36" x2="72" y2="36" stroke="#444" stroke-width="0.3" opacity="0.4"/>
    <line x1="54" y1="42" x2="72" y2="42" stroke="#444" stroke-width="0.3" opacity="0.4"/>
    <line x1="54" y1="48" x2="72" y2="48" stroke="#444" stroke-width="0.3" opacity="0.4"/>
    <line x1="54" y1="54" x2="72" y2="54" stroke="#444" stroke-width="0.3" opacity="0.4"/>
    <path d="M62,22 L62,14 L66,18 L70,14 L70,22" fill="${C.task}" opacity="0.7"/>
    <g transform="translate(22,30) scale(0.56)" filter="url(#logoSh)">
      <path d="M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70"
            stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.9"/>
      <path d="M50 70 L50 85 L80 70"
            stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.9"/>
    </g>
  </g>`
)

// --- C11: Fingerprint M ---
const fpOffsets = [-9, -6, -3, 0, 3, 6, 9]
const fpOpacities = [0.15, 0.3, 0.55, 0.9, 0.55, 0.3, 0.15]
const fpLines = fpOffsets
  .map(
    (dy, i) => `
    <path d="M20 ${70 + dy} L20 ${30 + dy} L35 ${45 + dy} L50 ${25 + dy} L65 ${45 + dy} L80 ${30 + dy} L80 ${70 + dy} L50 ${70 + dy}"
          stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="${fpOpacities[i]}"/>
    <path d="M50 ${70 + dy} L50 ${85 + dy} L80 ${70 + dy}"
          stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="${fpOpacities[i]}"/>`
  )
  .join('')

const c11 = svg(
  '',
  `
  <g transform="translate(10,10) scale(0.8)">
    ${fpLines}
  </g>`
)

// --- C12: Prism ---
const c12 = svg(
  `
    <linearGradient id="prismFace" x1="35" y1="28" x2="60" y2="72" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2a2a3a"/><stop offset="1" stop-color="#1a1a2a"/>
    </linearGradient>`,
  `
  <g transform="translate(10,10) scale(0.8)">
    <line x1="5" y1="50" x2="35" y2="50" stroke="#fff" stroke-width="2.5" opacity="0.8"/>
    <polygon points="35,28 35,72 68,50" fill="url(#prismFace)" stroke="#666" stroke-width="1.5"/>
    <line x1="35" y1="50" x2="68" y2="50" stroke="#555" stroke-width="0.5" opacity="0.3"/>
    <line x1="68" y1="50" x2="95" y2="28" stroke="${C.inbox}" stroke-width="2.5" opacity="0.9"/>
    <line x1="68" y1="50" x2="95" y2="41" stroke="${C.journal}" stroke-width="2.5" opacity="0.9"/>
    <line x1="68" y1="50" x2="95" y2="59" stroke="${C.task}" stroke-width="2.5" opacity="0.9"/>
    <line x1="68" y1="50" x2="95" y2="72" stroke="${C.note}" stroke-width="2.5" opacity="0.9"/>
    <line x1="35" y1="29" x2="35" y2="40" stroke="#fff" stroke-width="0.6" opacity="0.3"/>
  </g>`
)

// --- Generate all ---
const CONCEPTS = [
  { name: 'c01-neural-network', svg: c01 },
  { name: 'c02-origami', svg: c02 },
  { name: 'c03-palace-door', svg: c03 },
  { name: 'c04-stacked-layers', svg: c04 },
  { name: 'c05-constellation', svg: c05 },
  { name: 'c06-infinity-m', svg: c06 },
  { name: 'c07-gem-crystal', svg: c07 },
  { name: 'c08-seal-stamp', svg: c08 },
  { name: 'c09-brainwave', svg: c09 },
  { name: 'c10-book', svg: c10 },
  { name: 'c11-fingerprint', svg: c11 },
  { name: 'c12-prism', svg: c12 }
]

async function main() {
  mkdirSync(OUT, { recursive: true })
  console.log(`Generating ${CONCEPTS.length} concept previews...\n`)
  for (const { name, svg: s } of CONCEPTS) {
    const buf = await sharp(Buffer.from(s)).resize(512, 512).png().toBuffer()
    writeFileSync(join(OUT, `${name}.png`), buf)
    console.log(`  ${name}.png`)
  }
  console.log(`\nDone → ${OUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
