# #5174 first-launch migration view

Live e2e build (`MEMRY_E2E_MIGRATION` scripted backend, sandboxed data dir, 480x360 window).

- `running-dark.png`: `hold:vault:2:3`, host dark scheme.
- `running-light.png`: same, light scheme emulated through CSSOM (the host stays dark).
- `reduced-motion.png`: `hold:vault:1:3`, reduced motion emulated through CSSOM; fill transition `0s none`.
- `failed-target-occupied-dark.png`: `fail:secrets:target-occupied`.
- `failed-io-light.png`: `fail:io`, light scheme emulated.
- `failed-core-file-exists-ar.png`: `fail:core-file-exists`, Arabic, RTL.
