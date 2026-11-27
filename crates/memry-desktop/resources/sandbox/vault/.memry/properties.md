---
properties:
  topics:
    type: multiselect
    options:
      - value: Spaceflight
        color: cobalt
      - value: History
        color: sand
      - value: Note-taking
        color: violet
      - value: Design
        color: teal
      - value: Writing
        color: rose
  stage:
    type: status
    categories:
      todo:
        label: To-do
        options:
          - value: Draft
            color: stone
            default: true
      in_progress:
        label: In progress
        options:
          - value: In review
            color: amber
      done:
        label: Complete
        options:
          - value: Approved
            color: emerald
  deadline:
    type: date
    showOnCalendar: true
  project:
    type: project
  mood:
    type: number
    options: []
  energy:
    type: number
    options: []
  sleep:
    type: number
    options: []
  owned:
    type: checkbox
    options: []
  tried:
    type: checkbox
    options: []
  workout:
    type: checkbox
    options: []
  url:
    type: url
    options: []
  source:
    type: url
    options: []
  summary:
    type: text
    options: []
  level:
    type: select
    options:
      - value: Beginner
        color: sage
      - value: Intermediate
        color: amber
      - value: Advanced
        color: coral
  Website:
    type: url
    options: []
  Industry:
    type: text
    options: []
  Location:
    type: text
    options: []
  Role:
    type: text
    options: []
  Email:
    type: text
    options: []
  Phone:
    type: text
    options: []
  Date:
    type: date
    showOnCalendar: true
  Author:
    type: text
    options: []
  Shelf:
    type: select
    options:
      - value: To read
        color: stone
      - value: Reading
        color: amber
      - value: Read
        color: green
  Rating:
    type: number
    options: []
  Finished:
    type: date
  Course:
    type: select
    options:
      - value: Breakfast
        color: lemon
      - value: Main
        color: coral
      - value: Side
        color: sage
      - value: Dessert
        color: plum
  Time:
    type: number
    options: []
  Servings:
    type: number
    options: []
  Contract:
    type: select
    options:
      - value: Retainer
        color: sky
      - value: Fixed price
        color: amber
      - value: Pilot
        color: violet
---

