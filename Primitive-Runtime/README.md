# Primitive Runtime — product source

This tree contains the **source used to build Primitive Runtime releases**, not the full JCode SDK. It includes the MCP TypeScript runtime, terminal operator panel, restricted Rust native executable, and its three local JCode crate dependencies.

## Build from source

Requires Node.js 24, npm and Rust stable:

```sh
npm ci --ignore-scripts
npm run build
cargo build --locked --release --manifest-path engine/jcode/modified/primitive/Cargo.toml
```

The runtime CLI is `dist/runtime/src/cli.js`; the native binary is in `engine/jcode/modified/primitive/target/release/`. Runtime configuration is managed through the operator panel. See `scripts/install.mjs` and `scripts/verify-release.mjs` for installation and release verification.

No internal specifications, tests, reviews, original JCode upstream mirror, unrelated SDK modules or debug traces are included. Windows 10/11 acceptance must be established on Windows separately; source availability is not a release acceptance claim.

Development occurs in a private repository. Verify signed releases with a publisher public key obtained through a separately trusted channel. Licensing and origin are documented in `engine/jcode/modified/LICENSE` and `engine/JCODE_PROVENANCE.json`.
