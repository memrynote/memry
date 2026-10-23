/**
 * Opening an Obsidian vault for the first time offers to work on a copy.
 *
 * Memry rewrites a checklist line when it turns it into a task: an Obsidian
 * Tasks line loses its plugin fields (`📅 2026-11-01`, `🔁 every week`) and
 * gains Memry's `{task:<id>}` suffix. The task keeps the due date, but the
 * file does not, so Obsidian, reading the same folder, shows the task without
 * one. A user moving from Obsidian lost every due date that way.
 *
 * So a folder holding `.obsidian/` and no `.memry/` is asked about before it
 * opens: copy it to `<name>-memrynote` beside it and open the copy, open the
 * original anyway, or cancel. A folder that already has `.memry/` opens
 * without asking. Memry has opened it before, and its owner chose then.
 *
 * The copy leaves out what belongs to the original alone: Obsidian's config,
 * its trash and the git history. It fills a hidden folder that is renamed into
 * place only when complete, so the original is never written and a failed copy
 * leaves nothing a later attempt could take for a vault.
 */

import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { dialog } from 'electron'

import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'
import { isVaultInitialized } from './init'

const log = createLogger('Vault:ObsidianCopy')

const COPY_SUFFIX = '-memrynote'
const LEFT_OUT = new Set(['.obsidian', '.trash', '.git'])

type CopyTarget = { kind: 'create' | 'reuse'; path: string }

type Choice = 'copy' | 'original' | 'cancel'

/** In button order. */
const CHOICES: readonly Choice[] = ['copy', 'original', 'cancel']

function isUnopenedObsidianVault(folder: string): boolean {
  const config = fs.statSync(path.join(folder, '.obsidian'), { throwIfNoEntry: false })
  return config?.isDirectory() === true && !isVaultInitialized(folder)
}

/**
 * `<name>-memrynote` beside the vault. A Memry vault already at a candidate is
 * the copy made last time and opens again. Any other folder there is left
 * alone and the next number is tried.
 */
function copyTargetFor(source: string): CopyTarget {
  const base = `${source}${COPY_SUFFIX}`
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    if (!fs.existsSync(candidate)) return { kind: 'create', path: candidate }
    if (isVaultInitialized(candidate)) return { kind: 'reuse', path: candidate }
  }
}

async function askHowToOpen(source: string, target: CopyTarget): Promise<Choice> {
  const t = getMainI18n().getFixedT(null, 'system')
  const names = { name: path.basename(source), copyName: path.basename(target.path) }
  const reuse = target.kind === 'reuse'
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: t('dialog.obsidianVault.title'),
    message: t('dialog.obsidianVault.message'),
    detail: t(
      reuse ? 'dialog.obsidianVault.detailExistingCopy' : 'dialog.obsidianVault.detail',
      names
    ),
    buttons: [
      t(reuse ? 'dialog.obsidianVault.buttonOpenCopy' : 'dialog.obsidianVault.buttonCopy'),
      t('dialog.obsidianVault.buttonOpenOriginal'),
      t('dialog.obsidianVault.buttonCancel')
    ],
    defaultId: 0,
    cancelId: 2
  })
  return CHOICES[response] ?? 'cancel'
}

async function copyVault(source: string, target: string): Promise<void> {
  const partial = path.join(
    path.dirname(target),
    `.${path.basename(target)}.partial-${randomUUID()}`
  )
  try {
    await fs.promises.cp(source, partial, {
      recursive: true,
      // A clone on APFS: instant, and no second copy of the bytes on disk.
      mode: fs.constants.COPYFILE_FICLONE,
      // The indexer dates notes from their files.
      preserveTimestamps: true,
      // A relative link keeps pointing inside the copy, not back at the original.
      verbatimSymlinks: true,
      filter: (entry) => path.dirname(entry) !== source || !LEFT_OUT.has(path.basename(entry))
    })
    await fs.promises.rename(partial, target)
  } catch (error) {
    await fs.promises
      .rm(partial, { recursive: true, force: true })
      .catch((cleanupError: unknown) =>
        log.warn('Could not remove a partial vault copy', { partial, cleanupError })
      )
    throw error
  }
}

/**
 * The folder `selectVault` opens for `picked`: the folder itself, its Memry
 * copy, or null when the user cancelled. Only an Obsidian vault Memry has
 * never opened is asked about.
 */
export async function resolveObsidianVaultOpen(picked: string): Promise<string | null> {
  const source = path.resolve(picked)
  if (!isUnopenedObsidianVault(source)) return picked

  const target = copyTargetFor(source)
  const choice = await askHowToOpen(source, target)
  switch (choice) {
    case 'cancel':
      return null
    case 'original':
      log.info('Opening an Obsidian vault in place', { source })
      return picked
    case 'copy':
      if (target.kind === 'create') {
        await copyVault(source, target.path)
        log.info('Copied an Obsidian vault before opening it', { source, target: target.path })
      }
      return target.path
    default: {
      const unreachable: never = choice
      return unreachable
    }
  }
}
