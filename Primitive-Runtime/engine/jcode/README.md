# JCode upstream source

JCode upstream is pinned as a **Git submodule** at `upstream/` (not vendored inline). The source code is downloaded during submodule initialization, not included directly in this repo's Git objects.

- Repository: https://github.com/1jehuang/jcode
- Exact upstream commit: `5e7e0457ce2c6f5ecc9903b6f8415d7805594b1e`
- Upstream license: MIT (preserve upstream `upstream/LICENSE`).
- Current state: unmodified upstream; restrictive Primitive Runtime engine is **not implemented**.

From the outer repository root:

```sh
git clone --recurse-submodules https://github.com/seezyes/Primitive-Runtime.git```

For existing clones:

```sh
git submodule update --init --recursive```

Development should implement and test the restricted headless `primitive` role, durable policy restoration, artifact ownership and generation fencing. To patch the upstream engine, fork/pin a separately maintained JCode repository, then update the submodule URL and SHA. No floating branches at startup.
