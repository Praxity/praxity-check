If `AGENTS.local.md` exists, read it before starting. It holds maintainer context and is not part of the repository.

See [README.md](README.md#quick-start) for setup, [Build a local distributable](README.md#build-a-local-distributable) for build commands, and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance. Follow the test commands in [.github/workflows/ci.yml](.github/workflows/ci.yml).

No code comments. Record non-obvious decisions in `docs/adr/` and known shortcuts as backlog items. `node scripts/check-comments.mjs` enforces this with a ratchet (`--update` after deleting comments).
