// A short note to attach the clip's video to: Maya's walk through Alfama, in the Lisbon folder. The
// video itself (assets/video-attach-alfama.mp4) is attached on camera through the app's picker.
export default function ({ cli }) {
  cli(
    'notes',
    'create',
    'Alfama walk',
    '--folder',
    'Lisbon',
    '--tag',
    'travel',
    '--content',
    'Sunday morning, up the hill from the tram stop. The view from the miradouro:'
  )
}
