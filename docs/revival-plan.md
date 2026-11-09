# Pear Desktop revival

## Intended result

Maintain the existing Electron application on the current 3.12 codebase, restore the four plugin IDs removed after 3.11, fix verified upstream regressions, and reduce resource use with measurements. Preserve existing settings and platform behavior. Each coherent change receives a signed commit by deruta74, a pull request in this fork, independent review, and merge after relevant checks.

## Restoration

- `adblocker`: restore InPlayer, WithBlocklists, and AdSpeedup; preserve persisted settings and coordinate ownership with do-not-track. Test mode changes, concurrent starts/stops, offline lists, and coexistence.
- `bypass-age-restrictions`: restore an optional, disabled-by-default plugin with pinned MIT upstream code. Disclose third-party proxy fallback. Test main-world injection and proxy request boundaries; verify live behavior separately.
- `no-google-login`: restore optional hiding of login-dependent controls without destructive DOM removal. Test repeated starts/stops, unrelated controls, and SPA updates.
- `compact-sidebar`: use the existing native sidebar safely; preserve the initial state on stop. Test absent/late DOM, native compact/full state, and repeated starts/stops.

## Bugfix and optimization

Review public upstream issues and feature PRs before selecting changes. Reproduce each selected defect and add a regression test before its fix. Begin with the confirmed renderer stylesheet leak: fifty enable/disable cycles retain fifty plugin sheets in the baseline. Bound resource ownership and serialize plugin lifecycle operations. Measure startup, idle/playback CPU, renderer heap and process memory using an isolated profile before claiming general improvements.

## Verification and delivery

Baseline: the initial checkout builds, typechecks, and passes its six existing Playwright tests. Lint has existing warnings. New unit/fixture tests cover restored behavior and lifecycle failures; they do not establish live YouTube behavior. Use an isolated profile for subsequent Electron tests and computer-use checks, preserving the installed app's profile. Test playback, next/previous, plugin menus, enable/disable/restart, and settings migration. Document unsupported live behavior and platform checks rather than treating fixtures as production proof. Keep feature PRs scoped; do not merge broad upstream PRs wholesale.

No release publishing is part of initial implementation. Further features follow restoration and verified fixes.
