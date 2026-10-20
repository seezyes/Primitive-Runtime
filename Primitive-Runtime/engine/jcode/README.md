# JCode source layout

- `upstream/` — **reference-only**, frozen copy of JCode v0.99.0 (commit `774613c90751b6a26ae9eb6a27be6aff3f210062`). Do not edit this directory.
- `modified/` — independent working copy, **all Primitive Runtime engine changes go here**.
- `patches/jcode-modifications.patch` — Git-style binary-capable diff from `upstream/` to `modified/`.
- `regenerate-patch.sh` — reproduce the diff: `bash Primitive-Runtime/engine/jcode/regenerate-patch.sh`.

Current patch is **empty**, since the modified tree starts identical to the reference. Generated patch files must be regenerated and committed with every modified-source change. The upstream tree is protected by project convention; Git itself does not preserve read-only permissions for ordinary files.

Both trees incorporate the **four OAuth literal redactions** performed during initial import (see `../JCODE_PROVENANCE.json`). This reference is a pinned, locally sanitized upstream snapshot rather than a byte-identical Git checkout of JCode's release.
