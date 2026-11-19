/** `<parent>/<name>` with the parent's separator, the folder main's `vault_create` makes. */
export function vaultFolderPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`
}
