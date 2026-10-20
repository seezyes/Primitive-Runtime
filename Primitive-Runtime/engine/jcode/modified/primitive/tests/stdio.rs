use jcode_primitive::policy::content_hash;
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

fn binary() -> std::path::PathBuf {
    option_env!("CARGO_BIN_EXE_jcode-primitive")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("CARGO_BIN_EXE_jcode-primitive").map(Into::into))
        .unwrap_or_else(|| {
            // Cargo versions that expose CARGO_BIN_EXE only at runtime still
            // place integration tests in <profile>/deps and the built binary
            // beside that directory. Never fall back to a globally installed executable.
            std::env::current_exe()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join(format!("jcode-primitive{}", std::env::consts::EXE_SUFFIX))
        })
}

fn invoke(frames: &[Value]) -> std::process::Output {
    let mut child = Command::new(binary())
        .arg("primitive")
        .env_clear()
        .env("JCODE_API_KEY", "ambient-key-must-never-appear")
        .env(
            "JCODE_CONFIG_DIR",
            "/nonexistent-ambient-config-that-must-not-be-read",
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let input = child.stdin.as_mut().unwrap();
        for frame in frames {
            serde_json::to_writer(&mut *input, frame).unwrap();
            input.write_all(b"\n").unwrap();
        }
    }
    drop(child.stdin.take());
    child.wait_with_output().unwrap()
}

#[test]
fn binary_roundtrip_uses_exact_protocol_and_never_imports_ambient_state() {
    let initial =
        json!({"artifact_hash":content_hash("old"),"artifact_version":0,"inbox_cursor":0});
    let updated =
        json!({"artifact_hash":content_hash("new"),"artifact_version":1,"inbox_cursor":0});
    let output = invoke(&[
        json!({"op":"init","id":"init","session_id":"s","policy":{"run_id":"r","role":"primitive","artifact_path":"src/a.ts","allowed_dependencies":[],"execution_generation":1,"policy_revision":"primitive-policy/1","max_tool_calls":10,"max_payload_bytes":65536},"state":initial}),
        json!({"op":"authorize","id":"authorize","session_id":"s","execution_generation":1,"tool_call":{"id":"write","name":"propose_patch","input":{"content":"new","expected_hash":content_hash("old"),"expected_version":0}}}),
        json!({"op":"complete","id":"complete","session_id":"s","execution_generation":1,"tool_call_id":"write","result":{"accepted":true},"is_error":false,"state":updated}),
        json!({"op":"snapshot","id":"snapshot","session_id":"s"}),
        json!({"op":"authorize","id":"forbidden","session_id":"s","execution_generation":1,"tool_call":{"id":"shell","name":"bash","input":{"command":"touch outside-the-owned-artifact"}}}),
        json!({"op":"cancel","id":"cancel","session_id":"s","execution_generation":1}),
    ]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(!text.contains("ambient-key-must-never-appear"));
    let responses: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 6);
    assert_eq!(
        responses[0]["result"]["engine_protocol"],
        "primitive-engine/1"
    );
    assert_eq!(responses[1]["result"]["action"]["name"], "propose_patch");
    assert_eq!(responses[3]["result"]["state"], updated);
    assert_eq!(
        responses[3]["result"]["transcript"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(responses[4]["error"]["code"], "TOOL_DENIED");
    assert_eq!(responses[5]["result"]["cleanup_ack"], true);
}

#[test]
fn version_is_machine_readable_and_ordinary_cli_modes_are_absent() {
    let output = Command::new(binary())
        .args(["version", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let version: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        version["upstream_commit"],
        "774613c90751b6a26ae9eb6a27be6aff3f210062"
    );
    assert_eq!(version["restricted_mode"], true);
    assert_eq!(version["ordinary_tools"], false);
    let output = Command::new(binary()).arg("run").output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}
