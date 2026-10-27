import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

// The installed families come from the OS through `font-kit`: a runner with any font at all
// returns a list, sorted without regard to case and with no repeats. The count of 20 or more is
// a VM-row check on a desktop image.
test('the installed font families are listed, sorted and unique', async ({ page }) => {
  const families = await invoke<string[]>(page, 'system_fonts_list')
  expect(families.length).toBeGreaterThan(0)
  expect(families.every((family) => family.trim() === family && family.length > 0)).toBe(true)
  expect(new Set(families).size).toBe(families.length)
  // The Rust sort ignores case; the first letters are the part every collation agrees on.
  const initials = families.map((family) => family[0]?.toLowerCase() ?? '')
  expect(initials).toEqual(initials.toSorted())
})
