# MCP dependency notices

Provide an offline, read-only notice document for the exact MCP SDK production dependency subtree. Preserve the accepted original notice bytes and source qualification labels; this feature does not establish complete application licensing coverage.

The selected design checks in 94 sanitized package/version/source bindings and their original notice files. A build plugin validates the SDK importer, exact peer-qualified snapshot and package lock blocks, graph membership, and notice hashes before emitting escaped static HTML into the existing packaged dist boundary. Changes outside that SDK subtree do not invalidate this binding. Declared optional dependencies and peer-context references describe the accepted graph, not every platform's installed selection or peer-range validation.

A localized entry alongside About opens a single lazy reusable sandboxed document window. The window has no Node integration, preload, script execution, remote requests, or navigation. Native About roles remain intact. Text uses system typography, comfortable line length, selectable wrapping notice text, and native light/dark colors.

Alternatives considered: loading notice text into the main process at runtime adds unnecessary heap cost; linking to remote notices breaks offline access and exact-byte binding. A generated static document uses the existing asset packaging boundary without a dependency.

No dependency pins, patches, SDK code, native application state, or unrelated production graph are changed. Actual packaged offline interaction remains a separate verification gate.
