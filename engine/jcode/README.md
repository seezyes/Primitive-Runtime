# Primitive Runtime JCode engine

**No upstream code has been vendored yet. No JCode commit has been selected or modified.**

Intended upstream: https://github.com/1jehuang/jcode

Before importing a source tree:

1. Inspect upstream license and redistribution requirements, preserve full license and attribution.
2. Record *exact* repository URL, upstream commit SHA, local patch series, SDK version and engine version in a tracked manifest.
3. Import pinned upstream-derived source into this directory (or an explicitly reproducible pinned submodule if the build system allows it).
4. Implement enforced, headless role-bound `primitive` mode, persistent tool restrictions and file-ownership write checks.
5. Implement cancellation, generation fencing, usage events and explicit generic model endpoint configuration.
6. Prove restrictions survive session restoration and reject unrelated user configuration, ambient credentials and recursive spawning.

Do not fetch a floating upstream branch at normal runtime or label upstream as a modified fork without actual modifications.
