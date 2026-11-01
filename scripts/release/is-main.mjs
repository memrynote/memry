// The entry check of the release and rehearsal programs.

/**
 * Whether the module whose `import.meta` this is was started as the program. A comparison of
 * `process.argv[1]` with the module's path is false when node was started through a symlink or
 * another spelling of the path, and the program then skipped its work and exited 0. Node before
 * 22.18 and 24.2 has no `import.meta.main`, and reading that as "imported" would skip it the same
 * way, so this throws instead.
 */
export function isMain(meta) {
  if (typeof meta.main !== 'boolean') {
    throw new Error(
      `${meta.filename} needs import.meta.main (Node 22.18, 24.2 or later), and this is Node ${process.version}`
    )
  }
  return meta.main
}
