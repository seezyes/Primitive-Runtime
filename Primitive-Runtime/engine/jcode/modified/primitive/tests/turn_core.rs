use jcode_message_types::{ContentBlock, ToolCall};
use jcode_primitive::{
    Engine,
    policy::content_hash,
    protocol::{Request, Response},
};
use jcode_turn_core::{Options, Phase, TurnMachine, text_blocks};
use serde_json::{Value, json};

fn state() -> Value {
    json!({"artifact_hash":content_hash("old"),"artifact_version":0,"inbox_cursor":0})
}
fn policy() -> Value {
    json!({"run_id":"run-a","role":"primitive","artifact_path":"src/owned.ts",
        "allowed_dependencies":["src/dependency.ts"],"execution_generation":1,
        "policy_revision":"primitive-policy/1","max_tool_calls":40,"max_payload_bytes":1048576})
}
fn dispatch(engine: &mut Engine, mut value: Value) -> Response {
    value["id"] = json!("request");
    if value.get("session_id").is_none() {
        value["session_id"] = json!("session");
    }
    if value.get("execution_generation").is_none()
        && !matches!(value["op"].as_str(), Some("init" | "snapshot"))
    {
        value["execution_generation"] = json!(1);
    }
    engine.dispatch(serde_json::from_value::<Request>(value).expect("valid test protocol"))
}
fn ok(response: Response) -> Value {
    assert!(response.ok, "{:?}", response.error);
    response.result.expect("successful response")
}
fn error(response: Response, expected: &str) {
    assert!(!response.ok, "unexpected success: {:?}", response.result);
    assert_eq!(response.error.unwrap().code, expected);
}
fn initialize(engine: &mut Engine, policy: Value) {
    let ack = ok(dispatch(
        engine,
        json!({"op":"init","policy":policy,"state":state()}),
    ));
    assert_eq!(ack["turn_core_protocol"], "jcode-turn/1");
    assert_eq!(ack["shared_ordinary_turn_core"], true);
}
fn begin(engine: &mut Engine, prior: Option<Value>) -> Value {
    ok(dispatch(
        engine,
        json!({"op":"turn_begin","system_prompt":"Immutable role policy.","input":"Update implementation.","prior":prior}),
    ))
}
fn request(engine: &mut Engine) -> Value {
    ok(dispatch(engine, json!({"op":"turn_request"})))
}
fn call(id: &str, name: &str, arguments: &str) -> Value {
    json!({"id":id,"type":"function","function":{"name":name,"arguments":arguments}})
}
fn response(
    engine: &mut Engine,
    request: &Value,
    text: Option<&str>,
    calls: Vec<Value>,
) -> Response {
    dispatch(
        engine,
        json!({"op":"turn_response","request_id":request["request_id"],
        "message":{"role":"assistant","content":text,"tool_calls":calls},"stop_reason":"tool_calls"}),
    )
}
fn authorize(engine: &mut Engine, call: &Value) -> Response {
    dispatch(
        engine,
        json!({"op":"authorize","tool_call":{"id":call["id"],"name":call["function"]["name"],
        "input":serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap()).unwrap()}}),
    )
}
fn complete(engine: &mut Engine, id: &str, result: Value, is_error: bool) -> Response {
    dispatch(
        engine,
        json!({"op":"complete","tool_call_id":id,"result":result,"is_error":is_error,"state":state()}),
    )
}
fn snapshot(engine: &mut Engine) -> Value {
    ok(dispatch(engine, json!({"op":"snapshot"})))
}
fn result_blocks(id: &str, result: &Value, is_error: bool) -> Vec<ContentBlock> {
    vec![ContentBlock::ToolResult {
        tool_use_id: id.into(),
        content: serde_json::to_string(result).unwrap(),
        is_error: Some(is_error),
    }]
}
fn native_call(call: &Value) -> ToolCall {
    ToolCall {
        id: call["id"].as_str().unwrap().into(),
        name: call["function"]["name"].as_str().unwrap().into(),
        input: serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap(),
        intent: None,
        thought_signature: None,
    }
}
fn compare_history(engine: &mut Engine, ordinary: &TurnMachine) {
    let restricted = snapshot(engine)["conversation"]["core"].clone();
    assert_eq!(
        restricted["messages"],
        serde_json::to_value(ordinary.messages()).unwrap()
    );
    assert_eq!(restricted["requests"], ordinary.request_count());
    assert_eq!(restricted["tool_calls"], ordinary.tool_call_count());
}

#[test]
fn ordinary_and_restricted_adapters_share_history_dispatch_order_and_continuation() {
    let mut engine = Engine::default();
    initialize(&mut engine, policy());
    begin(&mut engine, None);
    let mut ordinary = TurnMachine::new(Options::ordinary());
    ordinary
        .begin_input(text_blocks("Update implementation."))
        .unwrap();
    let native_request = request(&mut engine);
    let ordinary_request = ordinary.request().unwrap();
    let calls = vec![
        call("self", "read_self", "{ }"),
        call(
            "dependency",
            "read_dependency",
            "{\"path\":\"src/dependency.ts\"}",
        ),
    ];
    let phase = ok(response(
        &mut engine,
        &native_request,
        Some("Inspect both files."),
        calls.clone(),
    ));
    ordinary
        .accept_response(
            ordinary_request,
            text_blocks("Inspect both files."),
            calls.iter().map(native_call).collect(),
            Some("tool_calls".into()),
        )
        .unwrap();
    assert_eq!(phase["phase"], "needs_tools");
    assert_eq!(ordinary.phase(), Phase::NeedsTools);
    compare_history(&mut engine, &ordinary);
    // Correlation is enforced before either host can apply an out-of-order effect.
    error(authorize(&mut engine, &calls[1]), "EFFECT_MISMATCH");
    assert_eq!(
        ordinary
            .complete_tool("dependency", result_blocks("dependency", &json!({}), false))
            .unwrap_err()
            .code,
        "EFFECT_MISMATCH"
    );
    for (index, wire) in calls.iter().enumerate() {
        ok(authorize(&mut engine, wire));
        let result = json!({"content":format!("file {index}"),"artifact_version":0});
        let id = wire["id"].as_str().unwrap();
        ok(complete(&mut engine, id, result.clone(), false));
        ordinary
            .complete_tool(id, result_blocks(id, &result, false))
            .unwrap();
        compare_history(&mut engine, &ordinary);
    }
    assert_eq!(ordinary.phase(), Phase::Ready);
    let native_request = request(&mut engine);
    assert_eq!(
        native_request["messages"][2]["tool_calls"][0]["function"]["arguments"],
        "{ }"
    );
    assert_eq!(native_request["messages"][3]["tool_call_id"], "self");
    assert_eq!(native_request["messages"][4]["tool_call_id"], "dependency");
    let ordinary_request = ordinary.request().unwrap();
    let phase = ok(response(
        &mut engine,
        &native_request,
        Some("Work is ready."),
        vec![],
    ));
    ordinary
        .accept_response(
            ordinary_request,
            text_blocks("Work is ready."),
            vec![],
            Some("tool_calls".into()),
        )
        .unwrap();
    compare_history(&mut engine, &ordinary);
    // The same engine permits plain-text completion in ordinary JCode; the
    // primitive policy requires an acknowledged structured terminal tool.
    assert_eq!(ordinary.phase(), Phase::Finished);
    assert_eq!(phase["phase"], "needs_correction");
}

#[test]
fn native_pending_completion_is_required_and_cannot_be_reordered_or_replaced() {
    let mut engine = Engine::default();
    initialize(&mut engine, policy());
    begin(&mut engine, None);
    error(
        authorize(&mut engine, &call("injected", "read_self", "{}")),
        "NO_PENDING_EFFECT",
    );
    let req = request(&mut engine);
    error(
        dispatch(&mut engine, json!({"op":"turn_request"})),
        "TURN_PENDING",
    );
    let mut stale = req.clone();
    stale["request_id"] = json!("session:turn:999");
    error(response(&mut engine, &stale, None, vec![]), "STALE_REQUEST");
    let calls = vec![
        call("read", "read_self", "{}"),
        call(
            "finish",
            "finish",
            "{\"artifact_version\":0,\"inbox_cursor\":0}",
        ),
    ];
    ok(response(&mut engine, &req, None, calls.clone()));
    error(
        response(&mut engine, &req, None, calls.clone()),
        "STALE_REQUEST",
    );
    error(authorize(&mut engine, &calls[1]), "EFFECT_MISMATCH");
    ok(authorize(&mut engine, &calls[0]));
    error(
        dispatch(
            &mut engine,
            json!({"op":"reject","tool_call_id":"read","result":{"error":"skip"}}),
        ),
        "EFFECT_PENDING",
    );
    error(
        complete(&mut engine, "finish", json!({}), false),
        "EFFECT_MISMATCH",
    );
    ok(complete(
        &mut engine,
        "read",
        json!({"content":"old"}),
        false,
    ));
    ok(authorize(&mut engine, &calls[1]));
    ok(complete(
        &mut engine,
        "finish",
        json!({"finished":true}),
        false,
    ));
    assert_eq!(
        snapshot(&mut engine)["conversation"]["core"]["phase"],
        "finished"
    );
    error(
        dispatch(&mut engine, json!({"op":"turn_request"})),
        "SESSION_TERMINAL",
    );
}

#[test]
fn malformed_json_and_denied_tools_get_correlated_errors_without_effects() {
    let mut engine = Engine::default();
    initialize(&mut engine, policy());
    begin(&mut engine, None);
    let req = request(&mut engine);
    let calls = vec![
        call("malformed", "read_self", "{broken-json"),
        call("escape", "bash", "{\"command\":\"ignored\"}"),
        call("allowed", "read_self", "{}"),
    ];
    ok(response(&mut engine, &req, None, calls.clone()));
    error(
        dispatch(
            &mut engine,
            json!({"op":"reject","tool_call_id":"escape","result":{}}),
        ),
        "EFFECT_MISMATCH",
    );
    ok(dispatch(
        &mut engine,
        json!({"op":"reject","tool_call_id":"malformed","result":{"error":"INVALID_ARGUMENT"}}),
    ));
    error(authorize(&mut engine, &calls[1]), "TOOL_DENIED");
    ok(dispatch(
        &mut engine,
        json!({"op":"reject","tool_call_id":"escape","result":{"error":"TOOL_DENIED"}}),
    ));
    ok(authorize(&mut engine, &calls[2]));
    ok(complete(
        &mut engine,
        "allowed",
        json!({"content":"old"}),
        false,
    ));
    let next = request(&mut engine);
    assert_eq!(
        next["messages"][2]["tool_calls"][0]["function"]["arguments"],
        "{broken-json"
    );
    for (index, id) in ["malformed", "escape", "allowed"].iter().enumerate() {
        assert_eq!(next["messages"][index + 3]["role"], "tool");
        assert_eq!(next["messages"][index + 3]["tool_call_id"], *id);
    }
    let saved = snapshot(&mut engine);
    assert_eq!(saved["state"], state());
    assert_eq!(saved["tool_calls"], 3);
    assert_eq!(
        saved["transcript"].as_array().unwrap().len(),
        2,
        "Only an authorized effect enters the effect audit"
    );
}

#[test]
fn correction_only_responses_consume_native_request_budget() {
    let mut engine = Engine::default();
    let mut small = policy();
    small["max_tool_calls"] = json!(2);
    initialize(&mut engine, small);
    begin(&mut engine, None);
    for _ in 0..2 {
        let req = request(&mut engine);
        let result = ok(response(
            &mut engine,
            &req,
            Some("Use ordinary shell instead."),
            vec![],
        ));
        assert_eq!(result["phase"], "needs_correction");
        ok(dispatch(
            &mut engine,
            json!({"op":"turn_correction","content":"Use finish."}),
        ));
    }
    error(
        dispatch(&mut engine, json!({"op":"turn_request"})),
        "BUDGET_EXCEEDED",
    );
    let saved = snapshot(&mut engine);
    assert_eq!(saved["conversation"]["core"]["requests"], 2);
    assert_eq!(saved["tool_calls"], 0);
}

#[test]
fn repeated_ids_and_nonfinal_terminal_calls_do_not_enter_history() {
    let mut engine = Engine::default();
    initialize(&mut engine, policy());
    begin(&mut engine, None);
    let req = request(&mut engine);
    error(
        response(
            &mut engine,
            &req,
            None,
            vec![
                call("same", "read_self", "{}"),
                call("same", "read_self", "{}"),
            ],
        ),
        "DUPLICATE_TOOL_CALL",
    );
    error(
        response(
            &mut engine,
            &req,
            None,
            vec![
                call(
                    "final",
                    "finish",
                    "{\"artifact_version\":0,\"inbox_cursor\":0}",
                ),
                call("later", "read_self", "{}"),
            ],
        ),
        "INVALID_ARGUMENT",
    );
    assert_eq!(
        snapshot(&mut engine)["conversation"]["core"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let read = call("read", "read_self", "{}");
    ok(response(&mut engine, &req, None, vec![read.clone()]));
    ok(authorize(&mut engine, &read));
    ok(complete(&mut engine, "read", json!({}), false));
    let req = request(&mut engine);
    error(
        response(&mut engine, &req, None, vec![read]),
        "DUPLICATE_TOOL_CALL",
    );
}

fn finished_conversation() -> Value {
    let mut engine = Engine::default();
    initialize(&mut engine, policy());
    begin(&mut engine, None);
    let req = request(&mut engine);
    let calls = vec![
        call(
            "old-read",
            "read_dependency",
            "{\"path\":\"src/dependency.ts\"}",
        ),
        call(
            "old-finish",
            "finish",
            "{\"artifact_version\":0,\"inbox_cursor\":0}",
        ),
    ];
    ok(response(&mut engine, &req, None, calls.clone()));
    for call in calls {
        ok(authorize(&mut engine, &call));
        ok(complete(
            &mut engine,
            call["id"].as_str().unwrap(),
            json!({"ok":true}),
            false,
        ));
    }
    snapshot(&mut engine)["conversation"].clone()
}

#[test]
fn reactivation_preserves_history_but_requires_new_policy_for_every_effect() {
    let prior = finished_conversation();
    let mut engine = Engine::default();
    let mut restricted = policy();
    restricted["allowed_dependencies"] = json!([]);
    initialize(&mut engine, restricted);
    begin(&mut engine, Some(prior.clone()));
    let req = request(&mut engine);
    assert_eq!(req["messages"].as_array().unwrap().len(), 6);
    let denied = call(
        "new-read",
        "read_dependency",
        "{\"path\":\"src/dependency.ts\"}",
    );
    ok(response(&mut engine, &req, None, vec![denied.clone()]));
    error(authorize(&mut engine, &denied), "ACCESS_DENIED");
    ok(dispatch(
        &mut engine,
        json!({"op":"reject","tool_call_id":"new-read","result":{"error":"ACCESS_DENIED"}}),
    ));
    let req = request(&mut engine);
    error(
        response(
            &mut engine,
            &req,
            None,
            vec![call(
                "old-finish",
                "finish",
                "{\"artifact_version\":0,\"inbox_cursor\":0}",
            )],
        ),
        "DUPLICATE_TOOL_CALL",
    );
    let finish = call(
        "new-finish",
        "finish",
        "{\"artifact_version\":0,\"inbox_cursor\":0}",
    );
    ok(response(&mut engine, &req, None, vec![finish.clone()]));
    ok(authorize(&mut engine, &finish));
    ok(complete(
        &mut engine,
        "new-finish",
        json!({"ok":true}),
        false,
    ));
    let next = snapshot(&mut engine)["conversation"].clone();
    assert_eq!(
        &next["core"]["messages"].as_array().unwrap()[..4],
        prior["core"]["messages"].as_array().unwrap()
    );
    assert_eq!(next["core"]["phase"], "finished");
}

fn resign(prior: &mut Value) {
    let mut content = prior.clone();
    content.as_object_mut().unwrap().remove("integrity");
    prior["integrity"] = json!(content_hash(&serde_json::to_string(&content).unwrap()));
}

#[test]
fn conversation_import_rejects_subject_mutation_corrupt_correlation_and_counter_forgery() {
    let original = finished_conversation();
    let mut mutations = Vec::new();
    let mut value = original.clone();
    value["session_id"] = json!("foreign");
    resign(&mut value);
    mutations.push(value);
    let mut value = original.clone();
    value["role"] = json!("diagnosis");
    resign(&mut value);
    mutations.push(value);
    let mut value = original.clone();
    value["artifact_path"] = json!("src/foreign.ts");
    resign(&mut value);
    mutations.push(value);
    let mut value = original.clone();
    value["core"]["messages"][2]["content"][0]["tool_use_id"] = json!("wrong");
    resign(&mut value);
    mutations.push(value);
    let mut value = original.clone();
    value["core"]["requests"] = json!(999);
    resign(&mut value);
    mutations.push(value);
    let mut value = original.clone();
    value["core"]["phase"] = json!("needs_tools");
    resign(&mut value);
    mutations.push(value);
    let mut value = original.clone();
    value["raw_arguments"]["old-read"] = json!("{\"path\":\"src/different.ts\"}");
    resign(&mut value);
    mutations.push(value);
    let mut value = original.clone();
    value["core"]["messages"][1]["content"][0]["name"] = json!("bash");
    resign(&mut value);
    mutations.push(value);
    let mut value = original.clone();
    value["system_prompt"] = json!("Change role");
    mutations.push(value);
    for prior in mutations {
        let mut engine = Engine::default();
        initialize(&mut engine, policy());
        error(
            dispatch(
                &mut engine,
                json!({"op":"turn_begin","system_prompt":"Immutable role policy.","input":"Update implementation.","prior":prior}),
            ),
            "INVALID_SNAPSHOT",
        );
    }
}

#[test]
fn prior_denied_tool_attempt_is_retained_as_an_error_and_never_becomes_authority() {
    let mut engine = Engine::default();
    initialize(&mut engine, policy());
    begin(&mut engine, None);
    let req = request(&mut engine);
    let denied = call("denied-bash", "bash", "{\"command\":\"ignored\"}");
    ok(response(&mut engine, &req, None, vec![denied.clone()]));
    error(authorize(&mut engine, &denied), "TOOL_DENIED");
    ok(dispatch(
        &mut engine,
        json!({"op":"reject","tool_call_id":"denied-bash","result":{"error":"TOOL_DENIED"}}),
    ));
    let prior = snapshot(&mut engine)["conversation"].clone();
    let mut resumed = Engine::default();
    initialize(&mut resumed, policy());
    begin(&mut resumed, Some(prior));
    let req = request(&mut resumed);
    assert_eq!(
        req["messages"][2]["tool_calls"][0]["function"]["name"],
        "bash"
    );
    assert_eq!(req["messages"][3]["content"], "{\"error\":\"TOOL_DENIED\"}");
    let another = call("another-bash", "bash", "{}");
    ok(response(&mut resumed, &req, None, vec![another.clone()]));
    error(authorize(&mut resumed, &another), "TOOL_DENIED");
}

#[test]
fn cancellation_fences_provider_responses_and_unauthorized_rejection_results() {
    let mut engine = Engine::default();
    initialize(&mut engine, policy());
    begin(&mut engine, None);
    let req = request(&mut engine);
    ok(dispatch(&mut engine, json!({"op":"cancel"})));
    error(
        response(
            &mut engine,
            &req,
            None,
            vec![call("after-cancel", "read_self", "{}")],
        ),
        "CANCELLED",
    );
    error(
        dispatch(
            &mut engine,
            json!({"op":"reject","tool_call_id":"after-cancel","result":{}}),
        ),
        "CANCELLED",
    );
    error(
        dispatch(&mut engine, json!({"op":"turn_request"})),
        "CANCELLED",
    );
    assert_eq!(
        snapshot(&mut engine)["conversation"]["core"]["phase"],
        "cancelled"
    );
}

#[test]
fn ordinary_only_external_tool_adapter_cannot_drop_restricted_pending_results() {
    let mut options = Options::ordinary();
    options.final_tool = Some("finish".into());
    let mut core = TurnMachine::new(options);
    core.begin_input(text_blocks("task")).unwrap();
    let request = core.request().unwrap();
    core.accept_response(
        request,
        vec![],
        vec![native_call(&call("one", "read_self", "{}"))],
        None,
    )
    .unwrap();
    assert_eq!(
        core.retain_local_calls(&[]).unwrap_err().code,
        "ACCESS_DENIED"
    );
    assert_eq!(core.phase(), Phase::NeedsTools);
    assert_eq!(core.pending().unwrap().id, "one");
    assert_eq!(
        core.replace_request_context(vec![]).unwrap_err().code,
        "TURN_PENDING"
    );
}

#[test]
fn history_limit_refuses_response_before_any_effect_can_be_authorized() {
    let mut engine = Engine::default();
    let mut bounded = policy();
    bounded["max_payload_bytes"] = json!(4096);
    initialize(&mut engine, bounded);
    begin(&mut engine, None);
    let req = request(&mut engine);
    error(
        response(
            &mut engine,
            &req,
            Some(&"x".repeat(5000)),
            vec![call("never", "read_self", "{}")],
        ),
        "BUDGET_EXCEEDED",
    );
    error(
        authorize(&mut engine, &call("never", "read_self", "{}")),
        "NO_PENDING_EFFECT",
    );
    assert_eq!(
        snapshot(&mut engine)["conversation"]["core"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
