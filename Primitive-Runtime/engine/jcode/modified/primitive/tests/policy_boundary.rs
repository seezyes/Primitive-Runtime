use jcode_primitive::{
    Engine,
    policy::content_hash,
    protocol::{Request, Response},
};
use serde_json::{Value, json};

fn state(version: u64, content: Option<&str>, inbox: u64) -> Value {
    json!({"artifact_hash":content.map(content_hash),"artifact_version":version,"inbox_cursor":inbox})
}
fn policy(role: &str, generation: u64) -> Value {
    json!({"run_id":"run-a","role":role,"artifact_path":if role == "primitive" {Some("src/owned.ts")} else {None},
        "allowed_dependencies":["src/owned.ts","src/dependency.ts","tests/check.ts"],
        "execution_generation":generation,"policy_revision":"primitive-policy/1","max_tool_calls":100,
        "max_payload_bytes":1048576})
}
fn dispatch(engine: &mut Engine, value: Value) -> Response {
    let request: Request = serde_json::from_value(value).expect("test request matches protocol");
    engine.dispatch(request)
}
fn initialize(engine: &mut Engine, role: &str) {
    let initial_state = if role == "primitive" {
        state(0, Some("old"), 0)
    } else {
        state(0, None, 0)
    };
    let response = dispatch(
        engine,
        json!({"op":"init","id":"init","session_id":"session","policy":policy(role,1),"state":initial_state}),
    );
    assert!(response.ok, "{:?}", response.error);
    assert_eq!(response.result.unwrap()["policy_ack"], true);
}
fn call(engine: &mut Engine, id: &str, name: &str, input: Value) -> Response {
    dispatch(
        engine,
        json!({"op":"authorize","id":"request","session_id":"session","execution_generation":1,
        "tool_call":{"id":id,"name":name,"input":input}}),
    )
}
fn complete(engine: &mut Engine, id: &str, is_error: bool, next_state: Value) -> Response {
    dispatch(
        engine,
        json!({"op":"complete","id":"result","session_id":"session","execution_generation":1,
        "tool_call_id":id,"result":{"ok":!is_error},"is_error":is_error,"state":next_state}),
    )
}
fn code(response: Response) -> String {
    assert!(!response.ok);
    response.error.unwrap().code
}
fn snapshot(engine: &mut Engine) -> Value {
    dispatch(
        engine,
        json!({"op":"snapshot","id":"snapshot","session_id":"session"}),
    )
    .result
    .unwrap()
}

#[test]
fn execution_without_explicit_policy_is_denied() {
    let mut engine = Engine::default();
    assert_eq!(
        code(call(&mut engine, "call", "read_self", json!({}))),
        "POLICY_REQUIRED"
    );
}

#[test]
fn every_role_rejects_ordinary_execution_and_recursive_orchestration() {
    for role in ["activator", "primitive", "diagnosis"] {
        let mut engine = Engine::default();
        initialize(&mut engine, role);
        for (i, tool) in [
            "bash",
            "shell",
            "write_file",
            "apply_patch",
            "swarm",
            "spawn",
            "mcp",
            "primitive_runtime",
            "selfdev",
            "read",
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(
                code(call(&mut engine, &format!("attack-{i}"), tool, json!({}))),
                "TOOL_DENIED"
            );
        }
    }
}

#[test]
fn role_boundaries_cannot_be_crossed_by_call_or_reinitialization() {
    for role in ["activator", "diagnosis"] {
        let mut engine = Engine::default();
        initialize(&mut engine, role);
        assert_eq!(
            code(call(
                &mut engine,
                "write",
                "propose_patch",
                json!({"content":"new","expected_hash":null,"expected_version":0})
            )),
            "TOOL_DENIED"
        );
        let response = dispatch(
            &mut engine,
            json!({"op":"init","id":"again","session_id":"session","policy":policy("primitive",2),"state":state(0,Some("old"),0)}),
        );
        assert_eq!(code(response), "SESSION_EXISTS");
    }
}

#[test]
fn patch_cannot_smuggle_a_second_path_or_omit_deletion_intent() {
    let mut engine = Engine::default();
    initialize(&mut engine, "primitive");
    let base =
        json!({"expected_hash":content_hash("old"),"expected_version":0,"content":"replacement"});
    for (index, field) in [
        "path",
        "artifact_path",
        "files",
        "patches",
        "execution_generation",
        "permission",
    ]
    .iter()
    .enumerate()
    {
        let mut input = base.clone();
        input[field] = json!("src/dependency.ts");
        assert_eq!(
            code(call(
                &mut engine,
                &format!("bad-{index}"),
                "propose_patch",
                input
            )),
            "INVALID_ARGUMENT"
        );
    }
    assert_eq!(
        code(call(
            &mut engine,
            "no-content",
            "propose_patch",
            json!({"expected_hash":content_hash("old"),"expected_version":0})
        )),
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        code(call(
            &mut engine,
            "binary",
            "propose_patch",
            json!({"expected_hash":content_hash("old"),"expected_version":0,"content":"binary\u{0}data"})
        )),
        "UNSUPPORTED_BINARY"
    );
}

#[test]
fn stale_proposals_and_unacknowledged_effects_are_fenced() {
    let mut engine = Engine::default();
    initialize(&mut engine, "primitive");
    assert_eq!(
        code(call(
            &mut engine,
            "stale",
            "propose_patch",
            json!({"expected_hash":content_hash("wrong"),"expected_version":0,"content":"new"})
        )),
        "PATCH_CONFLICT"
    );
    assert!(
        call(
            &mut engine,
            "write",
            "propose_patch",
            json!({"expected_hash":content_hash("old"),"expected_version":0,"content":"new"})
        )
        .ok
    );
    assert_eq!(
        code(call(&mut engine, "parallel", "read_self", json!({}))),
        "EFFECT_PENDING"
    );
    assert_eq!(
        code(complete(
            &mut engine,
            "other",
            false,
            state(1, Some("new"), 0)
        )),
        "EFFECT_MISMATCH"
    );
    assert_eq!(
        code(complete(
            &mut engine,
            "write",
            false,
            state(1, Some("unproposed"), 0)
        )),
        "PATCH_CONFLICT"
    );
    assert_eq!(
        code(complete(
            &mut engine,
            "write",
            false,
            state(2, Some("new"), 0)
        )),
        "PATCH_CONFLICT"
    );
    assert!(complete(&mut engine, "write", false, state(1, Some("new"), 0)).ok);
    assert_eq!(
        code(call(&mut engine, "write", "read_self", json!({}))),
        "DUPLICATE_TOOL_CALL"
    );
    assert_eq!(
        code(call(
            &mut engine,
            "stale-again",
            "propose_patch",
            json!({"expected_hash":content_hash("old"),"expected_version":0,"content":"next"})
        )),
        "PATCH_CONFLICT"
    );
}

#[test]
fn only_a_successful_owned_write_can_advance_hash_or_version() {
    let mut engine = Engine::default();
    initialize(&mut engine, "primitive");
    assert!(call(&mut engine, "read", "read_self", json!({})).ok);
    assert_eq!(
        code(complete(
            &mut engine,
            "read",
            false,
            state(1, Some("new"), 0)
        )),
        "PATCH_CONFLICT"
    );
    assert!(complete(&mut engine, "read", false, state(0, Some("old"), 0)).ok);
    assert!(
        call(
            &mut engine,
            "write",
            "propose_patch",
            json!({"expected_hash":content_hash("old"),"expected_version":0,"content":"new"})
        )
        .ok
    );
    assert_eq!(
        code(complete(
            &mut engine,
            "write",
            true,
            state(1, Some("new"), 0)
        )),
        "PATCH_CONFLICT"
    );
    assert!(complete(&mut engine, "write", true, state(0, Some("old"), 0)).ok);
}

#[test]
fn controlled_new_file_and_deletion_keep_explicit_version_history() {
    let mut engine = Engine::default();
    let response = dispatch(
        &mut engine,
        json!({"op":"init","id":"init","session_id":"session","policy":policy("primitive",1),"state":state(0,None,0)}),
    );
    assert!(response.ok);
    assert!(
        call(
            &mut engine,
            "create",
            "propose_patch",
            json!({"expected_hash":null,"expected_version":0,"content":"first"})
        )
        .ok
    );
    assert!(complete(&mut engine, "create", false, state(1, Some("first"), 0)).ok);
    assert!(
        call(
            &mut engine,
            "delete",
            "propose_patch",
            json!({"expected_hash":content_hash("first"),"expected_version":1,"content":null})
        )
        .ok
    );
    assert!(complete(&mut engine, "delete", false, state(2, None, 0)).ok);
}

#[test]
fn dependency_access_uses_exact_portable_identity() {
    let mut engine = Engine::default();
    initialize(&mut engine, "primitive");
    for (i, path) in [
        "../secret",
        "/etc/passwd",
        "C:/Windows/file",
        "src\\dependency.ts",
        "src/../dependency.ts",
        ".git/config",
        "src/CON.txt",
        "src/name.",
        "src/name ",
        "src//dependency.ts",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(
            code(call(
                &mut engine,
                &format!("path-{i}"),
                "read_dependency",
                json!({"path":path})
            )),
            "INVALID_PATH"
        );
    }
    assert_eq!(
        code(call(
            &mut engine,
            "unlisted",
            "read_dependency",
            json!({"path":"src/unlisted.ts"})
        )),
        "ACCESS_DENIED"
    );
    assert_eq!(
        code(call(
            &mut engine,
            "case",
            "read_dependency",
            json!({"path":"src/Dependency.ts"})
        )),
        "ACCESS_DENIED"
    );
    assert!(
        call(
            &mut engine,
            "allowed",
            "read_dependency",
            json!({"path":"src/dependency.ts"})
        )
        .ok
    );
}

#[test]
fn cancellation_rejects_late_tools_and_callbacks_and_is_idempotent() {
    let mut engine = Engine::default();
    initialize(&mut engine, "primitive");
    assert!(
        call(
            &mut engine,
            "write",
            "propose_patch",
            json!({"expected_hash":content_hash("old"),"expected_version":0,"content":"new"})
        )
        .ok
    );
    for _ in 0..2 {
        let response = dispatch(
            &mut engine,
            json!({"op":"cancel","id":"cancel","session_id":"session","execution_generation":1}),
        );
        assert!(response.ok);
        assert_eq!(response.result.unwrap()["cleanup_ack"], true);
    }
    assert_eq!(
        code(complete(
            &mut engine,
            "write",
            false,
            state(1, Some("new"), 0)
        )),
        "CANCELLED"
    );
    assert_eq!(
        code(call(&mut engine, "late", "read_self", json!({}))),
        "CANCELLED"
    );
    assert_eq!(snapshot(&mut engine)["state"], state(0, Some("old"), 0));
}

#[test]
fn finish_is_a_watermark_barrier_not_just_a_running_count() {
    let mut engine = Engine::default();
    initialize(&mut engine, "primitive");
    assert_eq!(
        code(call(
            &mut engine,
            "bad",
            "finish",
            json!({"artifact_version":0,"inbox_cursor":1})
        )),
        "INBOX_CONFLICT"
    );
    assert!(
        call(
            &mut engine,
            "finish-1",
            "finish",
            json!({"artifact_version":0,"inbox_cursor":0})
        )
        .ok
    );
    assert_eq!(
        code(complete(
            &mut engine,
            "finish-1",
            false,
            state(0, Some("old"), 1)
        )),
        "INBOX_CONFLICT"
    );
    assert!(!snapshot(&mut engine)["finished"].as_bool().unwrap());
    // The host rejects completion and delivers the new message before retry.
    assert!(complete(&mut engine, "finish-1", true, state(0, Some("old"), 1)).ok);
    assert!(
        call(
            &mut engine,
            "finish-2",
            "finish",
            json!({"artifact_version":0,"inbox_cursor":1})
        )
        .ok
    );
    assert!(complete(&mut engine, "finish-2", false, state(0, Some("old"), 1)).ok);
    assert_eq!(
        code(call(&mut engine, "after-finish", "read_self", json!({}))),
        "SESSION_TERMINAL"
    );
}

#[test]
fn snapshot_restore_needs_same_policy_and_new_generation_and_preserves_limits() {
    let mut original = Engine::default();
    initialize(&mut original, "primitive");
    assert!(call(&mut original, "read", "read_self", json!({})).ok);
    assert!(complete(&mut original, "read", false, state(0, Some("old"), 0)).ok);
    let saved = snapshot(&mut original);
    for (variant, error) in [
        (policy("primitive", 1), "STALE_GENERATION"),
        (policy("activator", 2), "POLICY_MISMATCH"),
    ] {
        let mut restored = Engine::default();
        let initial_state = if variant["role"] == "primitive" {
            state(0, Some("old"), 0)
        } else {
            state(0, None, 0)
        };
        assert_eq!(
            code(dispatch(
                &mut restored,
                json!({"op":"init","id":"restore","session_id":"session","policy":variant,"state":initial_state,"restore":saved})
            )),
            error
        );
    }
    let mut restored = Engine::default();
    assert!(dispatch(&mut restored,json!({"op":"init","id":"restore","session_id":"session","policy":policy("primitive",2),"state":state(0,Some("old"),0),"restore":saved})).ok);
    assert_eq!(
        code(call(&mut restored, "old-gen", "read_self", json!({}))),
        "STALE_GENERATION"
    );
    let duplicate = dispatch(
        &mut restored,
        json!({"op":"authorize","id":"dup","session_id":"session","execution_generation":2,"tool_call":{"id":"read","name":"read_self","input":{}}}),
    );
    assert_eq!(code(duplicate), "DUPLICATE_TOOL_CALL");
    let current = snapshot(&mut restored);
    assert_eq!(current["tool_calls"], saved["tool_calls"]);
    assert_eq!(current["transcript"], saved["transcript"]);
}

#[test]
fn crashed_unacknowledged_write_is_never_replayed() {
    let mut original = Engine::default();
    initialize(&mut original, "primitive");
    assert!(
        call(
            &mut original,
            "write",
            "propose_patch",
            json!({"expected_hash":content_hash("old"),"expected_version":0,"content":"new"})
        )
        .ok
    );
    let saved = snapshot(&mut original);
    let mut restored = Engine::default();
    assert_eq!(
        code(dispatch(
            &mut restored,
            json!({"op":"init","id":"restore","session_id":"session","policy":policy("primitive",2),"state":state(0,Some("old"),0),"restore":saved})
        )),
        "RECOVERY_REQUIRED"
    );
}

#[test]
fn limits_apply_to_rejected_calls_and_cannot_be_reset() {
    let mut engine = Engine::default();
    let mut restricted = policy("primitive", 1);
    restricted["max_tool_calls"] = json!(1);
    assert!(dispatch(&mut engine,json!({"op":"init","id":"init","session_id":"session","policy":restricted,"state":state(0,Some("old"),0)})).ok);
    assert_eq!(
        code(call(&mut engine, "bad", "bash", json!({}))),
        "TOOL_DENIED"
    );
    assert_eq!(
        code(call(&mut engine, "retry", "read_self", json!({}))),
        "BUDGET_EXCEEDED"
    );
    let saved = snapshot(&mut engine);
    let mut expanded = restricted;
    expanded["max_tool_calls"] = json!(2);
    expanded["execution_generation"] = json!(2);
    assert_eq!(
        code(dispatch(
            &mut Engine::default(),
            json!({"op":"init","id":"restore","session_id":"session","policy":expanded,"state":state(0,Some("old"),0),"restore":saved})
        )),
        "POLICY_MISMATCH"
    );
}

#[test]
fn cumulative_bytes_include_initialization_and_tool_traffic() {
    let mut engine = Engine::default();
    let mut restricted = policy("primitive", 1);
    restricted["max_payload_bytes"] = json!(1024);
    assert!(dispatch(&mut engine,json!({"op":"init","id":"init","session_id":"session","policy":restricted,"state":state(0,Some("old"),0)})).ok);
    assert_eq!(
        code(call(
            &mut engine,
            "large",
            "send_message",
            json!({"recipient_id":"other","type":"interface","payload":"x".repeat(400)})
        )),
        "BUDGET_EXCEEDED"
    );
}

#[test]
fn malformed_protocol_and_unknown_policy_fields_are_not_ignored() {
    assert!(serde_json::from_value::<Request>(json!({"op":"authorize","id":"a","session_id":"s","execution_generation":1,"tool_call":{"id":"t","name":"read_self","input":{},"permissions":"all"}})).is_err());
    let mut bad = policy("primitive", 1);
    bad["tools"] = json!(["bash"]);
    assert!(serde_json::from_value::<Request>(json!({"op":"init","id":"i","session_id":"s","policy":bad,"state":state(0,Some("old"),0)})).is_err());
}

#[test]
fn a_plan_can_coordinate_new_artifacts_without_granting_read_access() {
    let mut engine = Engine::default();
    initialize(&mut engine, "activator");
    assert_eq!(
        code(call(
            &mut engine,
            "early-read",
            "read_file",
            json!({"path":"src/new.ts"})
        )),
        "ACCESS_DENIED"
    );
    assert!(call(&mut engine, "plan", "submit_plan", json!({
        "assignments":[
            {"path":"src/new.ts","objective":"Implement the new entry point","dependencies":["src/helper.ts"],"create":true},
            {"path":"src/helper.ts","objective":"Implement its helper","dependencies":[],"create":true}
        ],
        "summary":"Coordinate two controller-reserved new files"
    })).ok);
    assert!(complete(&mut engine, "plan", false, state(0, None, 0)).ok);
    assert_eq!(snapshot(&mut engine)["state"], state(0, None, 0));
}

#[test]
fn diagnosis_can_name_a_missing_artifact_but_cannot_modify_it() {
    let mut engine = Engine::default();
    initialize(&mut engine, "diagnosis");
    assert!(
        call(
            &mut engine,
            "diagnosis",
            "submit_diagnosis",
            json!({
                "verdict":"fail",
                "evidence":["The configured check reported a missing entry point"],
                "causes":[{"path":"src/deleted.ts","reason":"The module was deleted"}],
                "guidance":[{"path":"src/deleted.ts","objective":"Restore the required interface"}],
                "summary":"A missing component prevents validation"
            })
        )
        .ok
    );
    assert!(complete(&mut engine, "diagnosis", false, state(0, None, 0)).ok);
    assert_eq!(snapshot(&mut engine)["state"], state(0, None, 0));
}

#[test]
fn positional_arrays_are_rejected_at_every_structured_tool_boundary() {
    for (role, tool, input) in [
        ("primitive", "read_self", json!([])),
        ("primitive", "read_dependency", json!(["src/dependency.ts"])),
        ("primitive", "finish", json!([0, 0])),
        (
            "primitive",
            "send_message",
            json!(["other", "interface", "literal"]),
        ),
        ("activator", "list_files", json!([])),
        ("activator", "list_files", json!({"prefix":null})),
        ("activator", "search", json!({"query":"x","path":null})),
        (
            "activator",
            "submit_plan",
            json!([[["src/owned.ts", "Edit", [], false]], "Plan"]),
        ),
        (
            "activator",
            "submit_plan",
            json!({"assignments":[["src/owned.ts", "Edit", [], false]], "summary":"Plan"}),
        ),
        (
            "diagnosis",
            "submit_diagnosis",
            json!({"verdict":"fail", "evidence":[], "causes":[["src/owned.ts", "Broken"]], "guidance":[], "summary":"Diagnosis"}),
        ),
        (
            "diagnosis",
            "submit_diagnosis",
            json!({"verdict":"fail", "evidence":[], "causes":[], "guidance":[["src/owned.ts", "Fix"]], "summary":"Diagnosis"}),
        ),
    ] {
        let mut engine = Engine::default();
        initialize(&mut engine, role);
        assert_eq!(
            code(call(&mut engine, "malformed", tool, input)),
            "INVALID_ARGUMENT",
            "{role} {tool}"
        );
    }
}

#[test]
fn restoration_replays_correlated_history_and_rejects_each_corruption() {
    let mut engine = Engine::default();
    initialize(&mut engine, "primitive");
    assert!(call(&mut engine, "read-1", "read_self", json!({})).ok);
    assert!(complete(&mut engine, "read-1", false, state(0, Some("old"), 1)).ok);
    assert!(
        call(
            &mut engine,
            "write",
            "propose_patch",
            json!({"expected_hash":content_hash("old"),"expected_version":0,"content":"new"})
        )
        .ok
    );
    assert!(complete(&mut engine, "write", false, state(1, Some("new"), 2)).ok);
    assert!(call(&mut engine, "read-2", "read_self", json!({})).ok);
    assert!(complete(&mut engine, "read-2", false, state(1, Some("new"), 2)).ok);
    let saved = snapshot(&mut engine);
    let restore = |saved: Value| {
        dispatch(
            &mut Engine::default(),
            json!({"op":"init", "id":"restore", "session_id":"session", "policy":policy("primitive",2), "state":saved["state"], "restore":saved}),
        )
    };
    assert!(
        restore(saved.clone()).ok,
        "A valid multi-state history must restore"
    );
    for variant in 0..12 {
        let mut bad = saved.clone();
        match variant {
            0 => bad["seen_tool_ids"][0] = json!("forged-history-id"),
            1 => {
                bad["transcript"][2] = bad["transcript"][0].clone();
                bad["transcript"][3] = bad["transcript"][1].clone();
            }
            2 => bad["transcript"][0]["role"] = json!("user"),
            3 => bad["transcript"][1]["content"][0]["tool_use_id"] = json!("other-call"),
            4 => bad["transcript"][0]["content"][0]["name"] = json!("bash"),
            5 => bad["transcript"][0]["content"][0]["input"] = json!([]),
            6 => bad["charged_bytes"] = json!(1000),
            7 => {
                bad["transcript"].as_array_mut().unwrap().remove(1);
            }
            8 => bad["completed_states"][1]["artifact_version"] = json!(8),
            9 => bad["initial_state"]["artifact_hash"] = json!(content_hash("wrong baseline")),
            10 => bad["state"]["artifact_hash"] = json!(content_hash("unrecorded output")),
            11 => bad["transcript"][1]["content"][0]["content"] = json!("not JSON"),
            _ => unreachable!(),
        }
        assert_eq!(
            code(restore(bad)),
            "INVALID_SNAPSHOT",
            "corruption {variant}"
        );
    }
}

#[test]
fn escaped_tool_results_cannot_exceed_the_durable_snapshot_budget() {
    let mut engine = Engine::default();
    let mut restricted = policy("primitive", 1);
    restricted["max_payload_bytes"] = json!(16 * 1024 * 1024);
    assert!(dispatch(&mut engine, json!({"op":"init", "id":"init", "session_id":"session", "policy":restricted, "state":state(0,Some("old"),0)})).ok);
    assert!(call(&mut engine, "read", "read_self", json!({})).ok);
    // Raw JSON is about 12 MiB; storing that JSON as ToolResult.content
    // needs roughly 24 MiB and must be rejected before acknowledgment.
    let oversized = dispatch(
        &mut engine,
        json!({"op":"complete", "id":"complete", "session_id":"session", "execution_generation":1, "tool_call_id":"read", "result":{"content":"\\".repeat(6 * 1024 * 1024)}, "is_error":false, "state":state(0,Some("old"),0)}),
    );
    assert_eq!(code(oversized), "BUDGET_EXCEEDED");
    assert!(complete(&mut engine, "read", true, state(0, Some("old"), 0)).ok);
    let saved = snapshot(&mut engine);
    assert!(serde_json::to_vec(&saved).unwrap().len() < 16 * 1024 * 1024);
    restricted["execution_generation"] = json!(2);
    let request = json!({"op":"init", "id":"restore", "session_id":"session", "policy":restricted, "state":state(0,Some("old"),0), "restore":saved});
    assert!(
        serde_json::to_vec(&request).unwrap().len() < jcode_primitive::protocol::MAX_FRAME_BYTES
    );
}
