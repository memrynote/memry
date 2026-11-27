---
properties:
  status:
    type: status
    categories:
      todo:
        label: To-do
        options:
          - value: idea
            color: violet
            default: true
          - value: backlog
            color: stone
          - value: planning
            color: sky
      in_progress:
        label: In progress
        options:
          - value: active
            color: amber
          - value: reading
            color: tangerine
          - value: blocked
            color: rose
      done:
        label: Complete
        options:
          - value: done
            color: emerald
          - value: watched
            color: mint
          - value: shipped
            color: sage
          - value: reference
            color: slate
          - value: abandoned
            color: mauve
  project:
    type: project
  priority:
    type: select
    options:
      - value: high
        color: rose
      - value: medium
        color: amber
        default: true
      - value: low
        color: stone
  area:
    type: select
    options:
      - value: Work
        color: cobalt
      - value: Health
        color: emerald
      - value: Travel
        color: tangerine
      - value: Learning
        color: violet
      - value: Home
        color: sage
      - value: Money
        color: lemon
  energy:
    type: select
    options:
      - value: deep
        color: indigo
      - value: shallow
        color: sand
      - value: admin
        color: slate
  genre:
    type: select
    options:
      - value: sci-fi
        color: indigo
      - value: drama
        color: plum
      - value: thriller
        color: rose
      - value: crime
        color: coral
      - value: animation
        color: mint
      - value: nonfiction
        color: sky
      - value: memoir
        color: sand
      - value: philosophy
        color: mauve
      - value: mystery
        color: teal
  format:
    type: multiselect
    options:
      - value: Hardcover
        color: sand
      - value: Kindle
        color: sky
      - value: Audiobook
        color: plum
      - value: Cinema
        color: rose
      - value: Streaming
        color: cyan
  source:
    type: multiselect
    options:
      - value: Recommended
        color: emerald
      - value: Bookclub
        color: amber
      - value: Rewatch
        color: violet
      - value: Backlog
        color: stone
  level:
    type: select
    options:
      - value: beginner
        color: sage
      - value: intermediate
        color: amber
      - value: advanced
        color: rose
  language:
    type: select
    options:
      - value: typescript
        color: sky
      - value: javascript
        color: amber
      - value: rust
        color: coral
      - value: sql
        color: violet
      - value: python
        color: lemon
      - value: shell
        color: slate
  feeling:
    type: select
    options:
      - value: great
        color: emerald
      - value: good
        color: sage
      - value: okay
        color: lemon
      - value: low
        color: coral
      - value: rough
        color: rose
  habits:
    type: multiselect
    options:
      - value: Reading
        color: violet
      - value: Meditation
        color: teal
      - value: Stretching
        color: amber
      - value: Walk
        color: sky
  finished:
    type: date
    showOnCalendar: false
  deadline:
    type: date
    showOnCalendar: true
  startDate:
    type: date
    showOnCalendar: true
  endDate:
    type: date
    showOnCalendar: true
  reviewOn:
    type: date
    showOnCalendar: true
  author:
    type: text
  location:
    type: text
  rating:
    type: number
  Role:
    type: text
  Email:
    type: text
  Phone:
    type: text
  Industry:
    type: text
  Website:
    type: url
  Thread:
    type: url
  Date:
    type: date
    showOnCalendar: true
  Start date:
    type: date
    showOnCalendar: false
  Follow up:
    type: date
    showOnCalendar: true
  Shelf:
    type: select
    options:
      - value: To read
        color: stone
      - value: Reading
        color: amber
      - value: Read
        color: green
  Team:
    type: select
    options:
      - value: Platform
        color: indigo
      - value: Design
        color: plum
      - value: Sales
        color: amber
---

