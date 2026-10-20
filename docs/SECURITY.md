# Security invariants (requirements, not implementation claims)

- **Fail closed:** absent operator profile, unsupported sandbox or unavailable pinned engine must reject start.
- **Trusted boundary:** only the operator controls workspace bindings, model URLs, secrets, validation commands, profiles and permissions.
- **Primitive ownership:** one writer per artifact; verify canonical identity, base hash, artifact version and execution generation at every write boundary.
- **No ambient access:** primitive sessions must not inherit shell, credentials, MCP tools, default JCode daemon, local agent history, or unrestricted tool policy on restart.
- **No recursive agents:** only controller creates and reassigns primitive sessions.
- **Staging only:** never mutate primary source files automatically; approved apply requires separate trusted capability, durable journal and conflict checks.
- **Real sandbox:** worktrees alone do not isolate tests; validation requires OS/container restrictions and process-tree cancellation.
- **Authorization:** a run ID is not a bearer credential; check the bound authenticated principal on every action.
- **Crash fencing:** interrupt abandoned work and reject callbacks from earlier generations.

Do not run this scaffold against untrusted tasks. See spec sections 4, 9, 11–13 for acceptance tests.
