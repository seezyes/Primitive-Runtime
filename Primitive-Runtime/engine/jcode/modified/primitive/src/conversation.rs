//! Native adapter around the ordinary JCode turn core. HTTP is deliberately
//! absent: the host gets a complete immutable request and returns a completion.
use crate::policy::{Policy, Role as PolicyRole, content_hash};
use crate::protocol::{ENGINE_PROTOCOL, EngineError, Result, WireToolCall};
use jcode_message_types::{ContentBlock, Role, ToolCall};
use jcode_turn_core::{Options, Snapshot as TurnSnapshot, TurnMachine, text_blocks};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderFunction {
    pub name: String,
    pub arguments: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderCall {
    pub id: String,
    pub r#type: String,
    pub function: ProviderFunction,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Assistant {
    pub role: String,
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<ProviderCall>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationSnapshot {
    pub engine_protocol: String,
    pub session_id: String,
    pub run_id: String,
    pub role: PolicyRole,
    pub artifact_path: Option<String>,
    pub system_prompt: String,
    pub core: TurnSnapshot,
    pub raw_arguments: BTreeMap<String, String>,
    pub integrity: String,
}

impl ConversationSnapshot {
    fn digest(&self) -> String {
        content_hash(&serde_json::to_string(&json!({
            "engine_protocol":self.engine_protocol, "session_id":self.session_id,
            "run_id":self.run_id,"role":self.role,"artifact_path":self.artifact_path,
            "system_prompt":self.system_prompt,"core":self.core,"raw_arguments":self.raw_arguments,
        })).expect("serializable conversation"))
    }
}

pub(crate) struct Conversation {
    session_id: String,
    policy: Policy,
    system_prompt: String,
    core: TurnMachine,
    raw_arguments: BTreeMap<String, String>,
}

fn core_error(error: jcode_turn_core::TurnError) -> EngineError {
    EngineError::new(error.code, error.message)
}

impl Conversation {
    pub(crate) fn new(
        session_id: &str,
        policy: &Policy,
        system_prompt: String,
        input: Option<String>,
        prior: Option<ConversationSnapshot>,
    ) -> Result<Self> {
        let prior_requests = prior.as_ref().map_or(0, |old| old.core.requests);
        let prior_calls = prior.as_ref().map_or(0, |old| old.core.tool_calls);
        let options = Options {
            max_requests: prior_requests
                .checked_add(policy.max_tool_calls)
                .ok_or_else(|| {
                    EngineError::new("BUDGET_EXCEEDED", "Conversation request counter exhausted")
                })?,
            max_tool_calls: prior_calls
                .checked_add(policy.max_tool_calls)
                .ok_or_else(|| {
                    EngineError::new("BUDGET_EXCEEDED", "Conversation tool counter exhausted")
                })?,
            max_tools_per_response: 16,
            max_history_bytes: policy.max_payload_bytes as usize,
            reject_reused_tool_ids: true,
            final_tool: Some(
                match policy.role {
                    PolicyRole::Primitive => "finish",
                    PolicyRole::Activator => "submit_plan",
                    PolicyRole::Diagnosis => "submit_diagnosis",
                }
                .into(),
            ),
        };
        let (mut core, raw_arguments) = if let Some(old) = prior {
            if old.engine_protocol != ENGINE_PROTOCOL
                || old.session_id != session_id
                || old.run_id != policy.run_id
                || old.role != policy.role
                || old.artifact_path != policy.artifact_path
                || old.system_prompt != system_prompt
                || old.integrity != old.digest()
            {
                return Err(EngineError::new(
                    "INVALID_SNAPSHOT",
                    "Conversation integrity or its session/role/artifact subject differs",
                ));
            }
            let mut observed = BTreeMap::new();
            let mut names = BTreeMap::new();
            let allowed_names = crate::tools::definitions(policy.role)
                .into_iter()
                .map(|tool| tool.name)
                .collect::<Vec<_>>();
            for message in &old.core.messages {
                for block in &message.content {
                    match block {
                        ContentBlock::Text {
                            cache_control: None,
                            ..
                        } => {}
                        ContentBlock::ToolUse {
                            id,
                            name,
                            input,
                            thought_signature: None,
                        } => {
                            let raw = old.raw_arguments.get(id).ok_or_else(|| {
                                EngineError::new(
                                    "INVALID_SNAPSHOT",
                                    "Conversation omitted original tool arguments",
                                )
                            })?;
                            let parsed = serde_json::from_str::<Value>(raw).unwrap_or(Value::Null);
                            if parsed != *input
                                || observed.insert(id.clone(), raw.clone()).is_some()
                            {
                                return Err(EngineError::new(
                                    "INVALID_SNAPSHOT",
                                    "Conversation arguments or identifiers differ from its history",
                                ));
                            }
                            names.insert(id.clone(), name.clone());
                        }
                        ContentBlock::ToolResult {
                            tool_use_id,
                            is_error: Some(is_error),
                            ..
                        } => {
                            if !is_error
                                && !names
                                    .get(tool_use_id)
                                    .is_some_and(|name| allowed_names.contains(name))
                            {
                                return Err(EngineError::new(
                                    "INVALID_SNAPSHOT",
                                    "Conversation claims a successful effect outside its immutable role catalog",
                                ));
                            }
                        }
                        _ => {
                            return Err(EngineError::new(
                                "INVALID_SNAPSHOT",
                                "Primitive conversation contains an unsupported content block",
                            ));
                        }
                    }
                }
            }
            if observed != old.raw_arguments {
                return Err(EngineError::new(
                    "INVALID_SNAPSHOT",
                    "Conversation contains unreferenced tool arguments",
                ));
            }
            (
                TurnMachine::restore_completed(old.core, options).map_err(core_error)?,
                old.raw_arguments,
            )
        } else {
            (TurnMachine::new(options), BTreeMap::new())
        };
        if let Some(input) = input {
            core.begin_input(text_blocks(&input)).map_err(core_error)?;
        }
        Ok(Self {
            session_id: session_id.into(),
            policy: policy.clone(),
            system_prompt,
            core,
            raw_arguments,
        })
    }

    pub(crate) fn request(&mut self) -> Result<Value> {
        let request = self.core.request().map_err(core_error)?;
        let mut messages = vec![json!({"role":"system","content":self.system_prompt})];
        for message in self.core.messages() {
            let text = message
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            if message.role == Role::Assistant {
                let mut calls = Vec::new();
                for block in &message.content {
                    if let ContentBlock::ToolUse {
                        id, name, input, ..
                    } = block
                    {
                        let arguments =
                            self.raw_arguments.get(id).cloned().unwrap_or_else(|| {
                                serde_json::to_string(input).expect("arguments")
                            });
                        calls.push(json!({"id":id,"type":"function","function":{"name":name,"arguments":arguments}}));
                    }
                }
                let mut assistant = json!({"role":"assistant","content":if text.is_empty() {None} else {Some(text)}});
                if !calls.is_empty() {
                    assistant["tool_calls"] = json!(calls);
                }
                messages.push(assistant);
            } else {
                let mut had_result = false;
                for block in &message.content {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } = block
                    {
                        messages.push(
                            json!({"role":"tool","tool_call_id":tool_use_id,"content":content}),
                        );
                        had_result = true;
                    }
                }
                if !had_result {
                    messages.push(json!({"role":"user","content":text}));
                }
            }
        }
        Ok(
            json!({"request_id":format!("{}:turn:{request}",self.session_id),"messages":messages,"tools":crate::tools::definitions(self.policy.role)}),
        )
    }

    pub(crate) fn response(
        &mut self,
        request_id: &str,
        assistant: Assistant,
        stop_reason: Option<String>,
    ) -> Result<Value> {
        if request_id != format!("{}:turn:{}", self.session_id, self.core.request_count()) {
            return Err(EngineError::new(
                "STALE_REQUEST",
                "Completion belongs to a different native request",
            ));
        }
        if assistant.role != "assistant"
            || stop_reason
                .as_ref()
                .is_some_and(|reason| reason.len() > 256)
        {
            return Err(EngineError::new(
                "INVALID_ARGUMENT",
                "Invalid normalized provider completion",
            ));
        }
        let calls = assistant.tool_calls.unwrap_or_default();
        if calls
            .iter()
            .any(|call| call.r#type != "function" || call.function.name.len() > 256)
        {
            return Err(EngineError::new(
                "INVALID_ARGUMENT",
                "Only bounded function calls are supported",
            ));
        }
        let native_calls = calls
            .iter()
            .map(|call| ToolCall {
                id: call.id.clone(),
                name: call.function.name.clone(),
                input: serde_json::from_str(&call.function.arguments).unwrap_or(Value::Null),
                intent: None,
                thought_signature: None,
            })
            .collect();
        self.core
            .accept_response(
                self.core.request_count(),
                text_blocks(assistant.content.as_deref().unwrap_or("")),
                native_calls,
                stop_reason,
            )
            .map_err(core_error)?;
        for call in &calls {
            self.raw_arguments
                .insert(call.id.clone(), call.function.arguments.clone());
        }
        Ok(json!({"tool_calls":calls,"phase":self.core.phase()}))
    }

    pub(crate) fn match_call(&self, call: &WireToolCall) -> Result<()> {
        let pending = self.core.pending().ok_or_else(|| {
            EngineError::new(
                "NO_PENDING_EFFECT",
                "No native completion tool call is pending",
            )
        })?;
        let raw = self
            .raw_arguments
            .get(&pending.id)
            .expect("accepted arguments");
        let input: Value = serde_json::from_str(raw).map_err(|_| {
            EngineError::new(
                "INVALID_ARGUMENT",
                "Provider tool arguments are malformed JSON",
            )
        })?;
        if pending.id != call.id || pending.name != call.name || input != call.input {
            return Err(EngineError::new(
                "EFFECT_MISMATCH",
                "Authorization does not match the pending native completion",
            ));
        }
        Ok(())
    }
    pub(crate) fn pending(&self) -> Result<WireToolCall> {
        self.core
            .pending()
            .map(|call| WireToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
            })
            .ok_or_else(|| {
                EngineError::new(
                    "NO_PENDING_EFFECT",
                    "No native completion tool call is pending",
                )
            })
    }
    pub(crate) fn result_blocks(id: &str, result: &Value, is_error: bool) -> Vec<ContentBlock> {
        vec![ContentBlock::ToolResult {
            tool_use_id: id.into(),
            content: serde_json::to_string(result).expect("result"),
            is_error: Some(is_error),
        }]
    }
    pub(crate) fn check_result(&self, id: &str, result: &Value, is_error: bool) -> Result<()> {
        self.core
            .check_result(id, &Self::result_blocks(id, result, is_error))
            .map_err(core_error)
    }
    pub(crate) fn result(&mut self, id: &str, result: &Value, is_error: bool) -> Result<()> {
        self.core
            .complete_tool(id, Self::result_blocks(id, result, is_error))
            .map_err(core_error)?;
        Ok(())
    }
    pub(crate) fn correction(&mut self, content: &str) -> Result<()> {
        self.core.correct(content).map_err(core_error)
    }
    pub(crate) fn cancel(&mut self) {
        self.core.cancel();
    }
    pub(crate) fn snapshot(&self) -> ConversationSnapshot {
        let mut snapshot = ConversationSnapshot {
            engine_protocol: ENGINE_PROTOCOL.into(),
            session_id: self.session_id.clone(),
            run_id: self.policy.run_id.clone(),
            role: self.policy.role,
            artifact_path: self.policy.artifact_path.clone(),
            system_prompt: self.system_prompt.clone(),
            core: self.core.snapshot(),
            raw_arguments: self.raw_arguments.clone(),
            integrity: String::new(),
        };
        snapshot.integrity = snapshot.digest();
        snapshot
    }
}
