# Scientific basis and evaluation protocol

## What is implemented and what is measured

The design follows the supplied [HERMES article, v1](https://arxiv.org/html/2610.07832v1)
and the repository's [engineering specification](01_Primitive_Runtime_Spec_v0.2.md).
The article is the research reference; the specification determines the product's
permissions, persistence, protocol and release requirements.

Implemented mechanisms include file-owned persistent identities, localized
objectives/read dependencies, literal addressed messages, same-round reactivation,
a deterministic completion barrier, read-only Activator retrieval and Diagnosis,
and bounded repairs of an independently checked candidate.

Several runtime decisions are engineering adaptations: a separate durable service,
authenticated MCP/control split, file compare-and-swap versions, generation fences,
OS validation sandboxes and staging-only delivery. They are not claimed as paper
results. Three additional revisions means one initial attempt plus up to three
repairs, not three total candidates.

The acceptance suite uses deterministic scripted model responses to make races,
incorrect tool calls, budget overruns and failures reproducible. It measures
whether runtime mechanisms hold. It does not measure a real model's reasoning,
completion rate, cost advantage or equivalence to HERMES benchmark scores.

**No comparative model benchmark has been claimed for this delivery.** No external
provider keys or paid evaluation budget were supplied for such an experiment.
The original paper's outcomes must not be copied into runtime results.

## Controlled three-condition comparison

| Condition          | Agent organization                                    | Diagnosis                              |
| ------------------ | ----------------------------------------------------- | -------------------------------------- |
| Plain pinned JCode | One ordinary coding session                           | No extra repair diagnostician          |
| File agents        | Same file ownership and direct-message machinery      | Disabled for the comparison            |
| Complete loop      | File ownership, direct messages and bounded revisions | Read-only, evidence-grounded Diagnosis |

The no-Diagnosis condition is an experimental configuration in an isolated
benchmark harness, not permission to bypass mandatory validation in the released
MCP tool. Ordinary JCode must also run under matched external filesystem/network
and resource restrictions. Giving the baseline broader access would confound
quality and cost comparisons.

Hold these inputs constant within each paired task:

- Pinned source baseline and task statement; unchanged hidden/held-out checks.
- Requested model route, reported model/provider identity, sampling controls and
  endpoint version where available.
- Total input/output, time, money and tool budgets, including probes, retries,
  schema corrections, Activator and Diagnosis costs.
- Validation image/tools, network policy, executable checks and resource limits.
- Warm/cold cache policy and compatibility-probe amortization policy.

Use repeated trials when the endpoint is nondeterministic. Record seeds if the
endpoint supports them, but do not equate a seed field with deterministic service
behavior. Randomize condition order to reduce transient provider/load effects.
Do not choose easier tasks for one condition or discard infrastructure failures.

## Required raw evidence

Each trial should preserve the task ID, baseline hash, condition, source/engine
versions, model profile revision, requested and reported routing identities,
prompt revisions, budget/profile hashes, start/end times, candidate hash, exact
check results and output references. Store actual and estimated usage separately.
Unknown price remains unknown. Provider-side billing after cancellation is not
assumed to be zero.

Classify outcomes separately as independently verified success, deterministic
check failure, task/model budget exhaustion, infrastructure unavailability,
cancellation or protocol/authority failure. A model PASS alone is never success.
Highlight changed tests and any natural-language criteria lacking independent
proof. Preserve failure traces and literal-message timing for mechanism analysis.

Report denominators, all exclusions and per-task paired outcomes. Aggregate
success rate with uncertainty intervals, wall-time and token/cost distributions,
not only best-case means. Report both total cost and any declared amortized probe
cost. Analyze the repair component using the file-agent ablation, and agent
organization using the matched plain-JCode condition. Do not infer causality from
unmatched models, different permissions or a single successful demo.

R3 comparative evaluation and the separate Srouter adapter remain follow-up
milestones. Their status is independent of Linux runtime mechanism acceptance.

## Primary references

- [HERMES article v1](https://arxiv.org/html/2610.07832v1).
- [Pinned JCode source](https://github.com/1jehuang/jcode/tree/774613c90751b6a26ae9eb6a27be6aff3f210062).
- [MCP 2025-06-18 tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
- [MCP 2025-06-18 transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

The implementation review record links each engineering claim to tests and
identifies platform gaps explicitly.
