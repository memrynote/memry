# Tutorials

YouTube tutorials for memrynote features: the real desktop app driven by an agent, narrated in
Kaan's ElevenLabs voice clone. The `tutorial-video` skill (`.pi/skills/tutorial-video/`) owns the
workflow, and `engine/build.mjs` builds one tutorial end to end:

```bash
node marketing/tutorials/engine/build.mjs tasks-projects
```

The film, captions and chapters land in `<topic>/out/`, which is gitignored.
