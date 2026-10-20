use crate::policy::{ArtifactState, Policy, Role, canonical_path, identifier};
use crate::protocol::{EngineError, Result};
use jcode_message_types::{ToolCall, ToolDefinition};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Debug)]
pub(crate) enum Effect {
    Observe,
    Write { content: Option<String> },
    Finish,
}

fn parse<T: DeserializeOwned>(value: &Value) -> Result<T> {
    if !value.is_object() {
        return Err(EngineError::new(
            "INVALID_ARGUMENT",
            "Tool arguments must be a JSON object, never a positional array",
        ));
    }
    serde_json::from_value(value.clone()).map_err(|_| {
        EngineError::new(
            "INVALID_ARGUMENT",
            "Tool arguments do not match the restricted tool schema",
        )
    })
}

fn object_items(value: &Value, field: &str) -> Result<()> {
    if !value
        .get(field)
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().all(Value::is_object))
    {
        return Err(EngineError::new(
            "INVALID_ARGUMENT",
            "Structured tool array entries must be JSON objects",
        ));
    }
    Ok(())
}

fn optional_string(value: &Value, field: &str) -> Result<()> {
    if value.get(field).is_some_and(|value| !value.is_string()) {
        return Err(EngineError::new(
            "INVALID_ARGUMENT",
            "Optional string arguments cannot be null or another JSON type",
        ));
    }
    Ok(())
}

fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        Err(EngineError::new(
            "INVALID_ARGUMENT",
            "Tool text must be nonempty and within its byte limit",
        ))
    } else {
        Ok(())
    }
}

fn allowed_read(policy: &Policy, path: &str) -> Result<()> {
    canonical_path(path)?;
    if !policy.permits_read(path) {
        return Err(EngineError::new(
            "ACCESS_DENIED",
            "The requested artifact is outside this session's read manifest",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Patch {
    expected_hash: Option<String>,
    expected_version: u64,
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendMessage {
    recipient_id: String,
    r#type: String,
    payload: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Activation {
    path: String,
    objective: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finish {
    artifact_version: u64,
    inbox_cursor: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    #[serde(default)]
    prefix: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    query: String,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assignment {
    path: String,
    objective: String,
    dependencies: Vec<String>,
    #[serde(default)]
    create: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    assignments: Vec<Assignment>,
    summary: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cause {
    path: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Guidance {
    path: String,
    objective: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Diagnosis {
    verdict: String,
    evidence: Vec<String>,
    causes: Vec<Cause>,
    guidance: Vec<Guidance>,
    summary: String,
}

pub(crate) fn check(policy: &Policy, state: &ArtifactState, call: &ToolCall) -> Result<Effect> {
    identifier(&call.id)?;
    // The allowlist is checked before decoding any tool arguments. Neither
    // a transcript nor an activation message can install additional tools.
    let permitted = match policy.role {
        Role::Primitive => [
            "read_self",
            "read_dependency",
            "propose_patch",
            "send_message",
            "request_activation",
            "finish",
        ]
        .contains(&call.name.as_str()),
        Role::Activator => {
            ["list_files", "search", "read_file", "submit_plan"].contains(&call.name.as_str())
        }
        Role::Diagnosis => {
            ["list_files", "search", "read_file", "submit_diagnosis"].contains(&call.name.as_str())
        }
    };
    if !permitted {
        return Err(EngineError::new(
            "TOOL_DENIED",
            "This tool is not available to the session role",
        ));
    }
    match call.name.as_str() {
        "read_self" => {
            let _: Empty = parse(&call.input)?;
        }
        "read_dependency" | "read_file" => {
            let input: Read = parse(&call.input)?;
            allowed_read(policy, &input.path)?;
        }
        "propose_patch" => {
            // Option fields in serde can otherwise be omitted, which would
            // turn an accidental missing `content` into a deletion.
            let object = call.input.as_object().ok_or_else(|| {
                EngineError::new("INVALID_ARGUMENT", "Patch input must be an object")
            })?;
            if !object.contains_key("content") || !object.contains_key("expected_hash") {
                return Err(EngineError::new(
                    "INVALID_ARGUMENT",
                    "Patch content and expected hash must be explicit, including null",
                ));
            }
            let input: Patch = parse(&call.input)?;
            if input.expected_hash != state.artifact_hash
                || input.expected_version != state.artifact_version
            {
                return Err(EngineError::new(
                    "PATCH_CONFLICT",
                    "Patch was proposed against a stale artifact identity",
                ));
            }
            if input
                .content
                .as_ref()
                .is_some_and(|content| content.contains('\0'))
            {
                return Err(EngineError::new(
                    "UNSUPPORTED_BINARY",
                    "Binary artifacts are not supported in primitive mode",
                ));
            }
            return Ok(Effect::Write {
                content: input.content,
            });
        }
        "send_message" => {
            let input: SendMessage = parse(&call.input)?;
            identifier(&input.recipient_id)?;
            text(&input.payload, 16 * 1024)?;
            if ![
                "interface",
                "dependency",
                "behavior",
                "test",
                "configuration",
                "observation",
                "requirement",
            ]
            .contains(&input.r#type.as_str())
            {
                return Err(EngineError::new(
                    "INVALID_ARGUMENT",
                    "Message type is not supported",
                ));
            }
        }
        "request_activation" => {
            let input: Activation = parse(&call.input)?;
            canonical_path(&input.path)?;
            text(&input.objective, 16 * 1024)?;
        }
        "finish" => {
            let input: Finish = parse(&call.input)?;
            if input.artifact_version != state.artifact_version
                || input.inbox_cursor != state.inbox_cursor
            {
                return Err(EngineError::new(
                    "INBOX_CONFLICT",
                    "Finish must acknowledge the current artifact and processed inbox watermark",
                ));
            }
            return Ok(Effect::Finish);
        }
        "list_files" => {
            optional_string(&call.input, "prefix")?;
            let input: List = parse(&call.input)?;
            if let Some(prefix) = input.prefix {
                if !prefix.is_empty() {
                    canonical_path(prefix.strip_suffix('/').unwrap_or(&prefix))?;
                }
            }
        }
        "search" => {
            optional_string(&call.input, "path")?;
            let input: Search = parse(&call.input)?;
            text(&input.query, 1024)?;
            if let Some(path) = input.path {
                allowed_read(policy, &path)?;
            }
        }
        "submit_plan" => {
            object_items(&call.input, "assignments")?;
            let input: Plan = parse(&call.input)?;
            text(&input.summary, 16 * 1024)?;
            if input.assignments.is_empty() || input.assignments.len() > 256 {
                return Err(EngineError::new(
                    "INVALID_ARGUMENT",
                    "A plan must contain between one and 256 assignments",
                ));
            }
            let mut seen = BTreeSet::new();
            let mut planned_paths = BTreeSet::new();
            for assignment in &input.assignments {
                canonical_path(&assignment.path)?;
                if !assignment.create {
                    allowed_read(policy, &assignment.path)?;
                }
                if !seen.insert(assignment.path.to_lowercase()) {
                    return Err(EngineError::new(
                        "OWNERSHIP_CONFLICT",
                        "A plan cannot assign the same artifact twice",
                    ));
                }
                planned_paths.insert(assignment.path.clone());
            }
            for assignment in input.assignments {
                text(&assignment.objective, 16 * 1024)?;
                if assignment.dependencies.len() > 256 {
                    return Err(EngineError::new(
                        "INVALID_ARGUMENT",
                        "Assignment dependency list is too large",
                    ));
                }
                for dependency in assignment.dependencies {
                    canonical_path(&dependency)?;
                    // This only describes a plan: references to another new
                    // planned artifact do not grant any read/write authority.
                    if !planned_paths.contains(&dependency) {
                        allowed_read(policy, &dependency)?;
                    }
                }
            }
            return Ok(Effect::Finish);
        }
        "submit_diagnosis" => {
            object_items(&call.input, "causes")?;
            object_items(&call.input, "guidance")?;
            let input: Diagnosis = parse(&call.input)?;
            if !["pass", "fail"].contains(&input.verdict.as_str())
                || input.evidence.len() > 256
                || input.causes.len() > 256
                || input.guidance.len() > 256
            {
                return Err(EngineError::new(
                    "INVALID_ARGUMENT",
                    "Diagnosis verdict or array bounds are invalid",
                ));
            }
            text(&input.summary, 16 * 1024)?;
            for evidence in input.evidence {
                text(&evidence, 16 * 1024)?;
            }
            for cause in input.causes {
                // Missing/deleted artifacts can be legitimate failure causes.
                // Naming a cause does not read it or extend the manifest.
                canonical_path(&cause.path)?;
                text(&cause.reason, 16 * 1024)?;
            }
            for guidance in input.guidance {
                canonical_path(&guidance.path)?;
                text(&guidance.objective, 16 * 1024)?;
            }
            return Ok(Effect::Finish);
        }
        _ => unreachable!("the exhaustive allowlist precedes dispatch"),
    }
    Ok(Effect::Observe)
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object", "additionalProperties":false, "properties":properties, "required":required})
}
fn string(max: u64) -> Value {
    json!({"type":"string", "minLength":1, "maxLength":max})
}
fn counter() -> Value {
    json!({"type":"integer", "minimum":0})
}

/// JCode ToolDefinition is the single catalog representation forwarded to the
/// trusted generic provider adapter. Capabilities are eager and never mutable.
pub fn definitions(role: Role) -> Vec<ToolDefinition> {
    let mut result = Vec::new();
    let mut add = |name: &str, description: &str, schema: Value| {
        result.push(ToolDefinition::new(name, description, schema));
    };
    if role == Role::Primitive {
        add(
            "read_self",
            "Read the owned artifact with its hash and version.",
            object(json!({}), &[]),
        );
        add(
            "read_dependency",
            "Read an allowed dependency and observe its version.",
            object(json!({"path":string(4096)}), &["path"]),
        );
        add(
            "propose_patch",
            "Replace only the owned UTF-8 artifact against its exact hash and version. Explicit null deletes the owned artifact.",
            object(
                json!({"expected_hash":{"type":["string","null"]}, "expected_version":counter(), "content":{"type":["string","null"]}}),
                &["expected_hash", "expected_version", "content"],
            ),
        );
        add(
            "send_message",
            "Send a literal addressed requirement through the controller's durable mailbox.",
            object(
                json!({"recipient_id":string(256),"type":{"type":"string","enum":["interface","dependency","behavior","test","configuration","observation","requirement"]},"payload":string(16384)}),
                &["recipient_id", "type", "payload"],
            ),
        );
        add(
            "request_activation",
            "Request controller consideration of another artifact; this does not grant access or spawn a session.",
            object(
                json!({"path":string(4096),"objective":string(16384)}),
                &["path", "objective"],
            ),
        );
        add(
            "finish",
            "Finish this assignment at the observed artifact and inbox watermarks.",
            object(
                json!({"artifact_version":counter(),"inbox_cursor":counter()}),
                &["artifact_version", "inbox_cursor"],
            ),
        );
    } else {
        add(
            "list_files",
            "Retrieve a bounded page from the authorized repository manifest.",
            object(json!({"prefix":{"type":"string","maxLength":4096}}), &[]),
        );
        add(
            "search",
            "Search allowed repository text; results are bounded by the runtime.",
            object(
                json!({"query":string(1024),"path":string(4096)}),
                &["query"],
            ),
        );
        add(
            "read_file",
            "Read one artifact from the authorized manifest without write capability.",
            object(json!({"path":string(4096)}), &["path"]),
        );
        if role == Role::Activator {
            let assignment = object(
                json!({"path":string(4096),"objective":string(16384),"dependencies":{"type":"array","maxItems":256,"items":string(4096)},"create":{"type":"boolean"}}),
                &["path", "objective", "dependencies"],
            );
            add(
                "submit_plan",
                "Submit artifact objectives and dependencies to the deterministic controller.",
                object(
                    json!({"assignments":{"type":"array","minItems":1,"maxItems":256,"items":assignment},"summary":string(16384)}),
                    &["assignments", "summary"],
                ),
            );
        } else {
            let cause = object(
                json!({"path":string(4096),"reason":string(16384)}),
                &["path", "reason"],
            );
            let guidance = object(
                json!({"path":string(4096),"objective":string(16384)}),
                &["path", "objective"],
            );
            add(
                "submit_diagnosis",
                "Attribute actual validation evidence. A model verdict cannot override failed mandatory checks.",
                object(
                    json!({"verdict":{"type":"string","enum":["pass","fail"]},"evidence":{"type":"array","maxItems":256,"items":string(16384)},"causes":{"type":"array","maxItems":256,"items":cause},"guidance":{"type":"array","maxItems":256,"items":guidance},"summary":string(16384)}),
                    &["verdict", "evidence", "causes", "guidance", "summary"],
                ),
            );
        }
    }
    result
}
