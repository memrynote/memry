/** Todoist CSV PRIORITY (4=P1 highest … 1=P4/none) → Memry priority (0 none … 4 urgent). */
export function todoistPriorityToMemry(n: number): 0 | 2 | 3 | 4 {
  if (n === 4) return 4
  if (n === 3) return 3
  if (n === 2) return 2
  return 0
}
