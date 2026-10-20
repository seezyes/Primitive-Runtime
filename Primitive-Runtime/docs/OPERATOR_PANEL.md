# Local operator panel

The terminal panel manages the standalone service through its authenticated
operator interface. It is adapted from the owner's `tui-mockup-src.zip`; source
provenance is recorded in
[`packages/operator-tui/NOTICE.md`](../packages/operator-tui/NOTICE.md).

Start the service and use the runtime's operator CLI to open the panel. The
CLI supplies its already authenticated, timeout-bounded `call(request)` client
to `runTui` from `packages/operator-tui/src/index.mjs`. The panel does not load
credentials, contact model endpoints directly or attach to a JCode daemon.
It does not start a missing service. Redirected input/output should use the
control CLI instead of the panel.

## Initial configuration

1. **Endpoints**: add a compatible OpenAI Chat Completions base URL. Use an
   environment reference such as `env:MODEL_API_KEY`, or an owner-only credential
   file reference such as `file:/private/model-key`; provide environment variables
   to the service process. A key must not be entered into the URL or pasted into
   the panel. Optional token prices remain unknown when left empty.
2. **Model profiles**: choose endpoint and opaque model IDs independently for
   Activator, Primitive and Diagnosis. Press **P** to run the service's model
   protocol probe. A successful chat response alone is not admission evidence.
3. **Validation checks**: choose `bwrap` or `docker`, then provide checks as a
   JSON array of executable names and argument arrays. At least one check must
   be mandatory. Set memory, CPU, process, output and scratch-disk limits.
   Network access is disabled. A Docker profile also needs a digest-pinned image.
   The **Runtime directories** JSON field adds at most 16 trusted absolute tool
   directories as read-only mounts, for example `["/opt/node"]` when Node is
   installed outside `/usr`. These directories must not contain credentials.
4. **Workspaces**: bind an absolute local Git worktree and optional default
   model/validation profile IDs. The **Workspace limits** JSON field sets narrower
   per-workspace limits; `{}` inherits operator limits. Only clean, supported
   workspaces are admitted.
5. **MCP clients**: create a principal, tool binding and explicit workspace,
   model-profile, validation-profile and action allowlists. Choose a new
   absolute output file for its credential. The service must write that file
   with owner-only protection. The panel never renders a returned credential.

Profile and workspace edits include the revision the operator actually opened.
The service rejects a stale revision. The panel keeps the unsaved form visible
so the operator can inspect the conflict. Refresh and reopen the editor before
submitting changes against the new revision. Edits affect new runs; existing
run configuration snapshots are unchanged.

## Keyboard and mouse

| Input                                   | Operation                                            |
| --------------------------------------- | ---------------------------------------------------- |
| **1–8**, **Tab**, **Left/Right**        | Switch sections                                      |
| **Up/Down**, **PgUp/PgDn**, mouse wheel | Select or scroll rows                                |
| **N**                                   | Create an entry in the current configuration section |
| **Enter**                               | Edit the selected entry or inspect a run/client      |
| **R**                                   | Refresh service state                                |
| **P** in Model profiles                 | Probe the selected model profile                     |
| **X** in MCP clients                    | Confirm and revoke the selected client               |
| **Tab / Up / Down** in a form           | Select a field                                       |
| **Ctrl+S**                              | Validate and save the form                           |
| **Enter** on the last field             | Validate and save the form                           |
| **Ctrl+U**                              | Clear the selected editable field                    |
| **Esc** in a form or dialog             | Cancel the local edit/dialog                         |
| **D / S** in Service                    | Confirm drain / stop                                 |
| **Q / Ctrl+C**                          | Close only the panel                                 |

SGR-compatible terminal mouse clicks select sections, rows and form fields.
Keyboard operation remains available when the terminal has no mouse support.
Bracketed paste inserts text into the current field; pasted newlines do not
submit a form or activate shortcuts. The panel uses the terminal's alternate
screen and restores cursor visibility, line wrapping, mouse mode and original
raw-input state on exit.

## Operational behavior

**Runs** shows actual persisted execution state and verification state supplied
by the service. **Service → Drain** rejects new starts while allowing accepted
runs to finish. **Service → Stop** uses the service's shutdown operation.
Closing the panel does not stop the service or cancel a run.

All display strings are bounded and stripped of terminal control sequences.
Credential fields and unexpected secret-bearing response fields are redacted.
Endpoint URLs cannot contain username/password, query-string keys or fragments.
The UI never executes arbitrary plugins or project commands. Validation
commands go to the trusted configuration interface and later run through the
runtime's isolation boundary.

`node --test tests/tui.test.mjs` checks real request construction, stale-revision
handling, secret and terminal-escape redaction, Unicode layout, fragmented input,
paste handling, confirmation paths and terminal cleanup using an injected
control callback. These checks exercise the terminal client; they do not claim
that a mocked control callback proves service or sandbox correctness.
