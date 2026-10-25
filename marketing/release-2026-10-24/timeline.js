// Cue sheet for the 2026.10.24 release film. Picture (index.html) and score (score.py) both read it.
// Keep the object strict JSON: score.py strips the assignment and parses the rest. The pre-commit
// hook runs prettier, which would unquote the keys; the prettier-ignore line below stops it.
// 120 BPM: a beat is 0.5 s, a bar is 2 s. Every section starts on a bar line.
// Each section is one capture of the real app. Its cues say when the next state of the same window is cut in,
// where the cursor clicks, which keycap is pressed and when the camera moves. out is the exit, which overlaps the next entrance.
// prettier-ignore
window.TL = {
  "fps": 60,
  "dur": 66,
  "bpm": 120,
  "version": "2026.10.24",
  "counts": {
    "features": 28,
    "fixes": 20
  },
  "open": {
    "dot": 0.1,
    "label": [
      0.42,
      0.92
    ],
    "reels": [
      0.9,
      2.0
    ],
    "caption": 2.06,
    "sub": 2.5,
    "cuts": [
      2.0,
      2.25,
      2.5,
      2.75,
      3.0,
      3.25
    ],
    "textOut": 3.3,
    "dive": [
      3.45,
      4.0
    ]
  },
  "readwise": {
    "start": 4.0,
    "head": 4.12,
    "sub": 4.7,
    "cursor": [
      4.1,
      4.9
    ],
    "row": 5.0,
    "token": 5.5,
    "tokenStep": 0.04,
    "connect": 7.0,
    "preview": 7.25,
    "pan": [
      7.9,
      8.4
    ],
    "journalHover": 8.2,
    "journal": 8.35,
    "importHover": 9.0,
    "import": 9.4,
    "done": 9.5,
    "doneClick": 10.05,
    "note": 10.1,
    "push": [
      10.1,
      10.7
    ],
    "pan2": [
      11.3,
      11.9
    ],
    "journalPage": 12.3,
    "jpush": [
      12.3,
      12.9
    ],
    "out": [
      13.45,
      14.0
    ]
  },
  "portals": {
    "start": 14.0,
    "head": 14.12,
    "sub": 14.7,
    "pick": 14.6,
    "query": 15.0,
    "sel": 15.6,
    "enter": 16.0,
    "insert": 16.05,
    "chevron": 16.6,
    "open": 16.65,
    "focus": 16.95,
    "type": 17.1,
    "typeStep": 0.16,
    "beside": 18.8,
    "live": 19.5,
    "paneRight": [20.8, 21.15],
    "liveStep": 0.2,
    "push": [
      18.8,
      19.4
    ],
    "out": [
      21.45,
      22.0
    ]
  },
  "timeline": {
    "start": 22.0,
    "head": 22.12,
    "sub": 22.7,
    "cursor": [
      22.2,
      22.75
    ],
    "dragStart": 22.75,
    "drag1": 22.95,
    "hold1": 23.2,
    "placed": 23.35,
    "resizeHover": 23.75,
    "resizeStart": 23.9,
    "resize": 24.2,
    "resized": 24.65,
    "drag2": 25.15,
    "hold2": 25.35,
    "placed2": 25.55,
    "back": 26.0,
    "hold3": 26.45,
    "unscheduled": 26.7,
    "push": [
      22.2,
      22.7
    ],
    "out": [
      27.45,
      28.0
    ]
  },
  "search": {
    "start": 28.0,
    "head": 28.12,
    "sub": 28.7,
    "open": 28.3,
    "type": 28.8,
    "step": 0.07,
    "text": "Bosphorus",
    "results": 29.6,
    "apollo": 30.5,
    "apolloResults": 31.0,
    "select": 31.6,
    "enter": 32.3,
    "opened": 32.35,
    "push": [
      32.35,
      32.95
    ],
    "out": [
      33.45,
      34.0
    ]
  },
  "levels": {
    "start": 34.0,
    "head": 34.12,
    "sub": 34.7,
    "cursor": [
      34.4,
      35.0
    ],
    "click": 35.05,
    "brief": 35.15,
    "keyClick": 36.25,
    "key": 36.3,
    "keyDone": 36.75,
    "takeClick": 37.65,
    "take": 37.7,
    "topicClick": 39.05,
    "topic": 39.1,
    "push": [
      39.9,
      40.7
    ],
    "out": [
      41.45,
      42.0
    ]
  },
  "palette": {
    "start": 42.0,
    "head": 42.12,
    "sub": 42.7,
    "key": 42.4,
    "type": 43.0,
    "step": 0.12,
    "sel": 44.15,
    "enter": 44.75,
    "dark": 44.8,
    "out": [
      47.45,
      48.0
    ]
  },
  "sticky": {
    "start": 48.0,
    "head": 48.12,
    "sub": 48.7,
    "card": 48.4,
    "focus": 48.8,
    "type": 48.95,
    "frameStep": 0.1,
    "typed": 50.0,
    "task": 50.5,
    "send": 51.0,
    "tuck": 52.0,
    "peek": 52.8,
    "push": [
      48.0,
      48.5
    ],
    "out": [
      53.45,
      54.0
    ]
  },
  "more": {
    "start": 54.0,
    "rows": [
      54.0,
      54.5
    ],
    "collapse": [
      58.9,
      59.9
    ]
  },
  "impacts": [
    [
      2.0,
      5
    ],
    [
      4.0,
      6
    ],
    [
      7.25,
      2
    ],
    [
      10.1,
      3
    ],
    [
      12.3,
      2
    ],
    [
      14.0,
      4
    ],
    [
      18.8,
      3
    ],
    [
      22.0,
      4
    ],
    [
      28.0,
      4
    ],
    [
      30.5,
      2
    ],
    [
      34.0,
      4
    ],
    [
      36.3,
      3
    ],
    [
      42.0,
      4
    ],
    [
      44.8,
      4
    ],
    [
      48.0,
      4
    ],
    [
      51.0,
      3
    ],
    [
      60.0,
      4
    ]
  ],
  "end": {
    "start": 60.0,
    "syllables": [
      60.25,
      60.5,
      60.75
    ],
    "tagline": 61.25,
    "url": 61.75,
    "meta": 62.25,
    "fade": [
      65.1,
      65.9
    ]
  }
}
