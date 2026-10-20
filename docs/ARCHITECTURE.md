# Architecture and delivery map

**Status:** planned; interfaces and example contracts are initial files, not an operational implementation.

```text
MCP client -> stdio adapter -> authenticated local IPC -> persistent runtime service
                                                          |-- admission + idempotency
                                                          |-- controller / activation
                                                          |-- artifact registry + mailbox
                                                          |-- restricted JCode sessions
                                                          |-- stage + snapshots
                                                          |-- isolated validation
                                                          +-- diagnosis and final reports
```

## Ordered milestones

- **R0: restricted engine.** Select and record the exact JCode upstream commit and license. Vendor a controlled fork in `engine/jcode/`, enforce role-bound headless sessions, forbid unrestricted tools, and add ownership/cancellation/restart security tests. **Not complete.**
- **R1: orchestration.** Implement service, transactional run store, single-writer artifact registry, bounded message bus, deterministic quiescence, staging, validation and bounded diagnosis. **Not complete.**
- **R2: public interfaces.** Implement MCP 2025-06-18 stdio adapter, authenticated operator-control API, idempotent run actions, packaging and crash recovery. **Not complete.**
- **R3: evaluation.** Verify standalone Windows x64/Linux x64 builds and run controlled comparisons before integrating with Srouter. **Not complete.**

## Proposed source layout

`packages/runtime/src/{mcp,control,controller,primitives,engine,workspace,validation,models,storage}/`

These directories should be created when their tested implementations are introduced. Do not ship empty placeholder implementations suggesting support for isolation or validation.

## Contract notes

`contracts/primitive-runtime-actions.schema.json` models **one logical action-discriminated input**. A production MCP adapter must register and test an actual MCP tool schema, error envelopes, structured content, and compatibility text blocks using the official SDK. Identity is established out of band, never by input arguments. The action schemas are preliminary and may narrow with real wire tests.
