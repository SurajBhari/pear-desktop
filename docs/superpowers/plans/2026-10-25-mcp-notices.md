# MCP Dependency Notices Implementation Plan

**Goal:** Ship a deterministic offline notice document for the bound 94-record MCP SDK subtree.

**Architecture:** Accepted public source bytes plus a sanitized binding feed a build-only emitter. A lazy secure local document window exposes the emitted asset through the existing About menu.

**Tech Stack:** Existing Node, Vite, TypeScript, Electron and test runners; no new dependency.

**Spec:** ../specs/2026-10-25-mcp-notices-design.md

## Constraints and review focus

Preserve all dependency locks, patches and SDK implementation. Bind only the SDK closure. Never copy local evidence paths or private fields. Keep original source qualification limits. Verify changed notice bytes, missing/duplicate graph records, unsafe paths, HTML injection, unrelated lock edits, and repeated/closed/failed window opens. No Electron/native launch during automated checks.

### Task 1: Bound notice emitter

- [x] Write node tests for deterministic HTML, exact source and graph binding, missing records, changed SHA, unsafe paths and escaping; observe failure.
- [x] Check in only the selected 94 public original notices and sanitized provenance.
- [x] Implement strict SDK-only lock block validation, original-byte checks and static HTML generation.
- [x] Verify explicit emitter tests; add one narrow Vite build hook and test emitted asset contract.

### Task 2: Offline document access

- [x] Write explicit window lifecycle/security tests with injected fake windows; observe failure.
- [x] Add a lazy reusable sandboxed window controller and localized About-adjacent entry, preserving About roles.
- [x] Verify failed loads dispose references, closing permits reopening, all requests/navigation are denied and no startup window is created.

### Task 3: Validation and handoff

- [x] Run explicit related tests, production types, lint, formatting and production build with Node 24.
- [x] Verify the emitted HTML byte-for-byte, asset packaging inclusion and unchanged dependency locks/patches.
- [x] Freeze source/evidence externally with hashes and remaining actual packaged/offline UI gates. Do not commit, push, launch or claim application-wide legal acceptance.
