# Changelog

## 0.1.1 — 2026-07-15

- Fix session replacement rebinding against an invalidated main session, which caused unrelated extensions to receive stale contexts after `/new`, `/fork`, or `/resume`.
- Add an interactive regression test covering extension rebinding after `/new`.

## 0.1.0 — 2026-07-12

- Add controllable in-process Pi subagents through `agents`.
- Add the interactive Agents dock, `/agents` manager command, and real-session foreground switching.
- Bundle a read-only `reviewer` profile.
- Add persisted run history and session revival.
- Add `agent_wait` for single-shot print and JSON modes.
- Add hermetic Faux Provider, VirtualTerminal, and stock Pi CLI coverage.
- Publish under the `claude-style-subagent` package name.
