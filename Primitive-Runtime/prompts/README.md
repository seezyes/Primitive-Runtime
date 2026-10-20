# Versioned agent prompts

This directory is reserved for Activator, Primitive and Diagnosis prompts after the corresponding policy-enforced role adapters are implemented.

A prompt never grants tool or filesystem authority. Permissions belong to the JCode execution boundary and artifact service. Messages between primitives cannot relax policy.

Prompt releases must include versioning, golden fixtures, schema-invalid-output handling and no-progress tests before use.
