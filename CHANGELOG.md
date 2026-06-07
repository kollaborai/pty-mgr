# Changelog

## 1.2.5 - 2026-06-06

### Added

- Added `p flow list` and `p flow run <name> --task <text>` for configurable
  multi-agent workflows.
- Added `pty-mgr.config.json` with Claude and Codex adapter examples plus
  `spec-writer` and `review-loop` flow examples.
- Added config-driven transcript parsing for sent user messages and completed
  assistant messages so flows can route between CLI tools without hardcoded
  agent-specific logic.
- Added flow regression tests for competing transcripts, reused sessions, custom
  adapters, steering templates, and CLI argument handling.

### Changed

- Promoted the agent relay prototype into the main single-file implementation
  under `lib/pty-manager.mjs`.
- Removed the old demo relay harness and standardized on `pty-mgr.config.json`.
- Improved setup wrappers, daemon argument parsing, wrap shell quoting, and
  client-supplied environment filtering.

### Fixed

- Fixed flow relay log binding so `p watch` completion cannot cause the relay to
  grab another active agent's newer transcript.
- Fixed reused-session flow handling by binding to the sent prompt instead of
  filtering only by transcript start time.
- Fixed `@...` payload handling so messages like `@everyone` are not mistaken
  for daemon selectors after the command position.
