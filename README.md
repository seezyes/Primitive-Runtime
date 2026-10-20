# Primitive Runtime

**MCP-native multi-agent coding runtime powered by a modified JCode engine.**

> **Status: R0 scaffolding only.** This repository is **not** an operational multi-agent runtime. No modified JCode binary, sandbox, durable controller, or production MCP service is currently shipped. Do not expose it to untrusted workspaces.

Primitive Runtime is designed as a standalone, Srouter-independent service: a lightweight MCP stdio adapter communicates with a persistent controller, which manages artifact-owned file agents, bounded messaging, validation, and **staged-only** results.

## Design and status

- [Specification v0.2](docs/01_Primitive_Runtime_Spec_v0.2.md) — normative engineering plan, not proof of implementation.
- [Architecture and milestones](docs/ARCHITECTURE.md)
- [JCode fork and upstream provenance](engine/jcode/README.md)
- [Security invariants](docs/SECURITY.md)
- [Contract schemas](contracts/) — machine-readable request shapes, **not yet a working server**.

## Development

Requires Node.js 22+ and npm.

```bash
npm install
npm run typecheck
npm test
```

No `primitive-runtime serve` / `primitive-runtime mcp` executable is available until the restricted JCode engine and persistent service pass their acceptance gates. Mocking a successful coding run is intentionally out of scope.

## Non-negotiable boundaries

1. One writer per owned artifact and server-side patch enforcement.
2. Operator-controlled profiles, credentials, workspaces and validation commands.
3. Isolated restricted JCode sessions; no ambient shell/recursive agent tools.
4. Durable idempotent runs with generation fencing and cancellation.
5. Validation in a real isolation backend, against an immutable candidate.
6. Output staged only; no automatic main-workspace edits, pushes or deployments.

See the specification for full contracts and release requirements.
