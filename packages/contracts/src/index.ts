// Keep the package root export intentionally empty for now.
// The contracts surface is consumed via subpath imports, and a broad barrel
// introduces duplicate symbol exports across independently named modules.
// oxlint-disable-next-line unicorn/require-module-specifiers -- intentionally empty root; consumers use subpath imports
export {}
