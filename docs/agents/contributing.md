# Contributor Guidelines

- Keep changes focused and reviewable
- add or update relevant tests
- When creating or submitting a pull request, disclose whether AI was used and briefly describe how
- Remind the human author that they are responsible for all submitted changes and refer them to CONTRIBUTING.md
- PR screenshots and recordings live on an orphan `pr-assets/<pr-number>-<slug>` branch. Include an empty `apps/landing/.gitkeep` next to the files. Vercel checks the landing project's root directory before the ignored-build-step command, and without that path every push fails with `ROOTDIR_NOT_EXIST` and sends a failure email. Both Vercel projects skip `pr-assets/*` branches through their ignored-build-step setting
