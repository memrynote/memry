// The graph needs a vault that looks lived in: the rest of Maya's month (world.mjs).
import { addWorld } from './world.mjs'

export default function ({ cli }) {
  addWorld(cli)
}
