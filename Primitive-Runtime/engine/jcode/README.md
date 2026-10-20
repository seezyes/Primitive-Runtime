# JCode source layout

- `upstream/` — **reference-only**, frozen copy of JCode v0.99.0 (commit `774613c90751b6a26ae9eb6a27be6aff3f210062`). Do not edit this directory.
- `modified/` — independent working copy, **all Primitive Runtime engine changes go here**.
- `patches/jcode-modifications.patch` — Git-style binary-capable diff from `upstream/` to `modified/`.
- `regenerate_patch.py` — reproduce the diff from the project directory with `python3 engine/jcode/regenerate_patch.py`; `regenerate-patch.sh` is a compatibility wrapper.

The controlled fork adds the `jcode-turn-core` crate, connects the ordinary
nonstreaming `Agent::run_turn` to it, and supplies the isolated
[`primitive/`](modified/primitive/README.md) executable. Both ordinary and
restricted sessions use the shared core for request history, assistant assembly
and ordered tool results. The restricted executable injects only role-scoped
tools and the explicit host model transport; it never loads the ordinary daemon,
tool registry or personal credentials. The separate upstream streaming loop is
unchanged.

`modified/Cargo.lock` pins the ordinary consumer's build graph, and
`modified/primitive/Cargo.lock` pins the small standalone graph. Generated patches
include the controlled source and lockfile changes, excluding build caches and
unrelated files. Regenerate and commit the patch after every modified-source
change. Verify it applies to a clean reference copy and reproduces the controlled
fork. The upstream tree is protected by project convention; Git does not preserve
read-only permissions for ordinary files.

Both trees incorporate the **four OAuth literal redactions** performed during initial import (see `../JCODE_PROVENANCE.json`). This reference is a pinned, locally sanitized upstream snapshot rather than a byte-identical Git checkout of JCode's release.
