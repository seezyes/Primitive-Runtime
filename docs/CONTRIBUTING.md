# Contributing

Start from [specification v0.2](01_Primitive_Runtime_Spec_v0.2.md). Keep runtime-independent contracts versioned. Submit small changes that include adversarial tests for permission boundaries.

Never declare production readiness based on a demo: satisfy R0–R2 release gates, including Windows/Linux packaging, cancellation races, crash fences, independent validation and snapshot conflicts.

Propose contract-breaking changes with migration fixtures and an explicit application-contract version revision.
