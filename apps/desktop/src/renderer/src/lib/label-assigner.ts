import type { HintTarget } from '@/contexts/hint-mode/types'

const ASCII_UPPER = /^[A-Z]$/

export const extractElementText = (el: HTMLElement): string => {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel?.trim()) return ariaLabel.trim()

  const textContent = el.textContent?.trim()
  if (textContent) return textContent

  const title = el.getAttribute('title')
  if (title?.trim()) return title.trim()

  return ''
}

const getFirstLetter = (text: string): string | null => {
  const char = text.charAt(0).toUpperCase()
  return ASCII_UPPER.test(char) ? char : null
}

const asciiLettersAfter = (text: string): string[] => {
  const letters: string[] = []
  const seen = new Set<string>()
  for (let i = 1; i < text.length; i++) {
    const char = text.charAt(i).toUpperCase()
    if (ASCII_UPPER.test(char) && !seen.has(char)) {
      letters.push(char)
      seen.add(char)
    }
  }
  return letters
}

const generateSequentialCode = (
  index: number,
  usedLabels: Set<string>,
  singleCharLabels: Set<string>
): string | null => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let seqIndex = 0
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = letters[i] + letters[j]
      if (singleCharLabels.has(code[0])) continue
      if (usedLabels.has(code)) continue
      if (seqIndex === index) return code
      seqIndex++
    }
  }
  return null
}

export const assignLabels = (elements: HTMLElement[]): HintTarget[] => {
  if (elements.length === 0) return []

  const texts = elements.map((el) => extractElementText(el))
  const firstLetters = texts.map((t) => getFirstLetter(t))

  const letterGroups = new Map<string, number[]>()
  const noLetterIndices: number[] = []

  firstLetters.forEach((letter, i) => {
    if (!letter) {
      noLetterIndices.push(i)
      return
    }
    const group = letterGroups.get(letter) ?? []
    group.push(i)
    letterGroups.set(letter, group)
  })

  const labels = new Array<string>(elements.length).fill('')
  const singleCharLabels = new Set<string>()

  for (const [letter, indices] of letterGroups) {
    if (indices.length === 1) {
      labels[indices[0]] = letter
      singleCharLabels.add(letter)
    }
  }

  const usedLabels = new Set<string>(singleCharLabels)
  const needsSequential: number[] = []

  for (const [letter, indices] of letterGroups) {
    if (indices.length <= 1) continue

    for (const idx of indices) {
      const candidates = asciiLettersAfter(texts[idx])
      let assigned = false
      for (const char of candidates) {
        const candidate = letter + char
        if (!usedLabels.has(candidate)) {
          labels[idx] = candidate
          usedLabels.add(candidate)
          assigned = true
          break
        }
      }
      if (!assigned) needsSequential.push(idx)
    }
  }

  const allNeedSequential = [...noLetterIndices, ...needsSequential]
  let seqCounter = 0
  for (const idx of allNeedSequential) {
    const code = generateSequentialCode(seqCounter, usedLabels, singleCharLabels)
    if (code === null) break
    labels[idx] = code
    usedLabels.add(code)
    seqCounter++
  }

  const targets: HintTarget[] = []
  for (let i = 0; i < elements.length; i++) {
    if (labels[i] === '') continue
    targets.push({
      element: elements[i],
      label: labels[i],
      rect: elements[i].getBoundingClientRect(),
      text: texts[i]
    })
  }
  return targets
}
