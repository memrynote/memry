// Cue sheet for the 2026.09.28 release film. Picture (index.html) and score (score.py) both read it.
// Keep the object strict JSON: score.py strips the assignment and parses the rest. The pre-commit
// hook runs prettier, which would unquote the keys; the prettier-ignore line below stops it.
// 120 BPM: a beat is 0.5 s, a bar is 2 s. Every section starts on a bar line.
// vaults.map pairs film time with time in shots/vaults.mp4; the picture eases between the pairs, so
// the recording speeds up and slows down around each switch. Switches and clicks sit on pairs.
// prettier-ignore
window.TL = {
  "fps": 60,
  "dur": 50,
  "bpm": 120,
  "version": "2026.09.28",
  "counts": { "features": 33, "improvements": 12, "fixes": 20 },
  "open": {
    "dot": 0.1,
    "label": [0.42, 0.92],
    "reels": [0.9, 2.0],
    "caption": 2.06,
    "sub": 2.5,
    "cuts": [2.0, 2.25, 2.5, 2.75, 3.0, 3.25],
    "textOut": 3.3,
    "dive": [3.45, 4.0]
  },
  "rail": {
    "start": 4.0,
    "head": 4.12,
    "morph": [4.5, 5.3],
    "pull": [5.3, 5.95],
    "sub": 5.75,
    "clicks": [6.0, 6.5, 7.0, 7.5],
    "cmd": 8.0,
    "press": 8.5,
    "release": 8.85,
    "out": [9.45, 10.0]
  },
  "vaults": {
    "start": 10.0,
    "in": [9.5, 10.3],
    "head": 10.12,
    "sub": 10.7,
    "lift": [10.3, 11.58],
    "switches": [11.0, 11.5, 12.5, 13.0],
    "clicks": [12.24, 13.0],
    "map": [[9.5, 0.36], [10.35, 0.62], [11.0, 1.533], [11.12, 2.08], [11.5, 2.883], [11.62, 3.3], [12.02, 3.95], [12.24, 4.27], [12.5, 4.65], [12.75, 5.3], [13.0, 5.46], [13.45, 6.0], [14.0, 6.3]],
    "out": [13.45, 14.0]
  },
  "agent": {
    "start": 14.0,
    "head": 14.15,
    "settle": [14.0, 14.8],
    "push": [14.72, 15.35],
    "edits": [15.0, 15.5, 16.0, 16.25, 16.5],
    "sub": 15.6,
    "bar": 17.0,
    "cursor": [17.08, 17.74],
    "press": 17.86,
    "accept": 18.0,
    "out": [19.45, 20.0]
  },
  "timeline": {
    "start": 20.0,
    "line": [20.0, 20.2],
    "pop": 20.2,
    "reveal": [20.24, 20.66],
    "rows": [20.62, 21.87],
    "head": 20.35,
    "sub": 21.1,
    "out": [23.45, 24.0]
  },
  "calendars": {
    "start": 24.0,
    "rows": [24.0, 24.375, 24.75, 25.125],
    "out": [25.72, 26.0]
  },
  "blocks": {
    "start": 26.0,
    "words": [26.0, 26.75, 27.5],
    "board": [26.05, 26.7],
    "diagram": [26.8, 27.4],
    "math": [27.55, 28.05],
    "pull": [28.1, 28.55],
    "head": 28.22,
    "headOut": 29.18,
    "dive": [29.45, 30.0]
  },
  "tasks": {
    "start": 30.0,
    "head": 30.1,
    "select": 30.12,
    "type": 30.3,
    "step": 0.0625,
    "text": "Book flights #travel @friday !high",
    "enter": 32.5,
    "sub": 32.8,
    "out": [33.5, 34.0]
  },
  "themes": {
    "start": 34.0,
    "head": 34.1,
    "sub": 34.9,
    "dark": [34.5, 0.25, ["ayu", "catppuccin", "dracula", "everforest", "github", "gruvbox", "kanagawa", "material"]],
    "light": [36.5, 0.125, ["monokai", "night-owl", "nord", "one", "rose-pine", "solarized", "tokyo-night"]],
    "settle": 37.5,
    "headOut": 37.3,
    "out": [37.7, 38.0]
  },
  "more": {
    "start": 38.0,
    "rows": [38.0, 38.5],
    "collapse": [42.9, 43.9]
  },
  "impacts": [[2.0, 5], [4.0, 6], [5.3, 2], [11.0, 2], [12.5, 3], [13.0, 2], [18.0, 3], [20.2, 3], [32.5, 3], [44.0, 4]],
  "end": {
    "start": 44.0,
    "syllables": [44.25, 44.5, 44.75],
    "tagline": 45.25,
    "url": 45.75,
    "meta": 46.25,
    "fade": [49.1, 49.9]
  }
}
