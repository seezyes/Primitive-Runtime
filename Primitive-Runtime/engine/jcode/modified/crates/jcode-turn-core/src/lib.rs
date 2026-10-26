//! Shared deterministic core extracted from JCode's ordinary Agent::run_turn.
//! Provider transport, registry effects, persistence, telemetry, memory and UI
//! are injected by outer adapters. This crate performs no I/O and reads no
//! configuration, environment, credentials or global process state.
//!
//! Both the ordinary modified Agent and jcode-primitive use the same request,
//! assistant assembly, ordered tool-result, continuation and cancellation
//! transitions below. The primitive adapter additionally enforces an immutable
//! role/artifact policy before forwarding any effect to its durable host.

use jcode_message_types::{ContentBlock, Message, Role, ToolCall};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnError {
    pub code: &'static str,
    pub message: &'static str,
}
impl std::fmt::Display for TurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for TurnError {}
pub type Result<T> = std::result::Result<T, TurnError>;
fn fail<T>(code: &'static str, message: &'static str) -> Result<T> {
    Err(TurnError { code, message })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Ready,
    AwaitingResponse,
    NeedsTools,
    NeedsCorrection,
    Finished,
    Cancelled,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub max_requests: u64,
    pub max_tool_calls: u64,
    pub max_tools_per_response: usize,
    pub max_history_bytes: usize,
    pub reject_reused_tool_ids: bool,
    /// Ordinary JCode may finish with text. A restricted assignment must
    /// acknowledge its role's structured terminal tool instead.
    pub final_tool: Option<String>,
}
impl Options {
    pub fn ordinary() -> Self {
        Self {
            max_requests: u64::MAX,
            max_tool_calls: u64::MAX,
            max_tools_per_response: 256,
            max_history_bytes: 256 * 1024 * 1024,
            reject_reused_tool_ids: false,
            final_tool: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub format: String,
    pub messages: Vec<Message>,
    pub stop_reasons: Vec<Option<String>>,
    pub requests: u64,
    pub tool_calls: u64,
    pub phase: Phase,
}

#[derive(Clone)]
pub struct TurnMachine {
    options: Options,
    messages: Vec<Message>,
    history_bytes: usize,
    stop_reasons: Vec<Option<String>>,
    phase: Phase,
    requests: u64,
    calls: u64,
    pending: VecDeque<ToolCall>,
    seen_ids: BTreeSet<String>,
}

/// The ordinary turn loop's assistant construction, including the ordering of
/// provider/native/reasoning prefix blocks before native tool-use blocks.
pub fn assistant_blocks(mut prefix: Vec<ContentBlock>, calls: &[ToolCall]) -> Vec<ContentBlock> {
    prefix.extend(calls.iter().map(ToolCall::to_tool_use_block));
    prefix
}

fn message(role: Role, content: Vec<ContentBlock>) -> Message {
    Message {
        role,
        content,
        timestamp: None,
        tool_duration_ms: None,
    }
}

pub fn text_blocks(text: &str) -> Vec<ContentBlock> {
    // Match ordinary JCode: whitespace-only provider text is not a completed
    // visible answer and must not enter history as a successful response.
    if text.trim().is_empty() {
        Vec::new()
    } else {
        vec![ContentBlock::Text {
            text: text.to_owned(),
            cache_control: None,
        }]
    }
}

impl TurnMachine {
    pub fn new(options: Options) -> Self {
        Self {
            options,
            messages: Vec::new(),
            history_bytes: 2,
            stop_reasons: Vec::new(),
            phase: Phase::Ready,
            requests: 0,
            calls: 0,
            pending: VecDeque::new(),
            seen_ids: BTreeSet::new(),
        }
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }
    pub fn pending(&self) -> Option<&ToolCall> {
        self.pending.front()
    }
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
    pub fn request_count(&self) -> u64 {
        self.requests
    }
    pub fn tool_call_count(&self) -> u64 {
        self.calls
    }

    fn active(&self) -> Result<()> {
        if self.phase == Phase::Cancelled {
            fail("CANCELLED", "Conversation was cancelled")
        } else {
            Ok(())
        }
    }
    fn append_bytes(&self, value: &Message) -> Result<usize> {
        let bytes = serde_json::to_vec(value)
            .expect("serializable JCode message")
            .len();
        let total = self.history_bytes.checked_add(bytes + 1).ok_or(TurnError {
            code: "BUDGET_EXCEEDED",
            message: "Conversation history is too large",
        })?;
        if total > self.options.max_history_bytes {
            return fail(
                "BUDGET_EXCEEDED",
                "Conversation history byte budget exhausted",
            );
        }
        Ok(total)
    }
    fn append(&mut self, value: Message) -> Result<()> {
        self.history_bytes = self.append_bytes(&value)?;
        self.messages.push(value);
        Ok(())
    }

    pub fn begin_input(&mut self, content: Vec<ContentBlock>) -> Result<()> {
        self.active()?;
        if matches!(self.phase, Phase::AwaitingResponse | Phase::NeedsTools) {
            return fail(
                "TURN_PENDING",
                "Pending provider or tool work must complete before new input",
            );
        }
        if content.iter().any(|block| {
            matches!(
                block,
                ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. }
            )
        }) {
            return fail(
                "INVALID_ARGUMENT",
                "New user input cannot smuggle tool calls or results",
            );
        }
        self.append(message(Role::User, content))?;
        self.phase = Phase::Ready;
        Ok(())
    }

    /// The ordinary adapter can install its explicitly assembled, compacted
    /// request context after all previous tool results are acknowledged. It is
    /// the only persistence-specific operation; the native primitive adapter
    /// never imports host-created request histories through this API.
    pub fn replace_request_context(&mut self, messages: Vec<Message>) -> Result<()> {
        self.active()?;
        if matches!(self.phase, Phase::AwaitingResponse | Phase::NeedsTools) {
            return fail(
                "TURN_PENDING",
                "Cannot replace history while a turn has pending work",
            );
        }
        let bytes = serde_json::to_vec(&messages)
            .expect("serializable JCode history")
            .len();
        if bytes > self.options.max_history_bytes {
            return fail(
                "BUDGET_EXCEEDED",
                "Conversation history byte budget exhausted",
            );
        }
        self.history_bytes = bytes;
        self.messages = messages;
        self.phase = Phase::Ready;
        Ok(())
    }

    pub fn request(&mut self) -> Result<u64> {
        self.active()?;
        if self.phase != Phase::Ready {
            return fail(
                "TURN_PENDING",
                "Conversation is not ready for another provider request",
            );
        }
        if self.requests >= self.options.max_requests {
            return fail("BUDGET_EXCEEDED", "Provider turn budget exhausted");
        }
        self.requests += 1;
        self.phase = Phase::AwaitingResponse;
        Ok(self.requests)
    }

    /// A failed provider attempt has no assistant message and no effects.
    /// Ordinary transport recovery can explicitly retry the request; the run's
    /// external usage ledger still accounts for the failed attempt.
    pub fn abandon_request(&mut self, request_id: u64) -> Result<()> {
        self.active()?;
        if self.phase != Phase::AwaitingResponse || request_id != self.requests {
            return fail(
                "STALE_REQUEST",
                "Provider request identity is no longer current",
            );
        }
        self.phase = Phase::Ready;
        Ok(())
    }

    pub fn accept_response(
        &mut self,
        request_id: u64,
        prefix: Vec<ContentBlock>,
        calls: Vec<ToolCall>,
        stop_reason: Option<String>,
    ) -> Result<Message> {
        self.active()?;
        if self.phase != Phase::AwaitingResponse || request_id != self.requests {
            return fail(
                "STALE_REQUEST",
                "Provider response does not match the pending request",
            );
        }
        if calls.len() > self.options.max_tools_per_response
            || self
                .calls
                .checked_add(calls.len() as u64)
                .is_none_or(|n| n > self.options.max_tool_calls)
        {
            return fail("BUDGET_EXCEEDED", "Completion tool-call budget exhausted");
        }
        if prefix.iter().any(|block| {
            matches!(
                block,
                ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. }
            )
        }) {
            return fail(
                "INVALID_ARGUMENT",
                "Assistant prefix cannot smuggle additional tool calls",
            );
        }
        let mut ids = BTreeSet::new();
        for (index, call) in calls.iter().enumerate() {
            if call.id.is_empty() || call.id.len() > 256 || call.id.contains('\0') {
                return fail("INVALID_ARGUMENT", "Tool-call identifier is invalid");
            }
            if !ids.insert(call.id.clone())
                || (self.options.reject_reused_tool_ids && self.seen_ids.contains(&call.id))
            {
                return fail(
                    "DUPLICATE_TOOL_CALL",
                    "Tool-call identifiers cannot be reused in a conversation",
                );
            }
            if self.options.final_tool.as_deref() == Some(call.name.as_str())
                && index + 1 != calls.len()
            {
                return fail(
                    "INVALID_ARGUMENT",
                    "The terminal tool must be last in its completion",
                );
            }
        }
        let assistant = message(Role::Assistant, assistant_blocks(prefix, &calls));
        self.append(assistant.clone())?;
        self.stop_reasons.push(stop_reason);
        self.calls += calls.len() as u64;
        self.seen_ids.extend(ids);
        self.pending = calls.into();
        self.phase = if self.pending.is_empty() {
            if self.options.final_tool.is_some() {
                Phase::NeedsCorrection
            } else {
                Phase::Finished
            }
        } else {
            Phase::NeedsTools
        };
        Ok(assistant)
    }

    pub fn check_result(&self, tool_call_id: &str, blocks: &[ContentBlock]) -> Result<()> {
        self.active()?;
        let Some(call) = self.pending.front() else {
            return fail("NO_PENDING_EFFECT", "No tool call is awaiting a result");
        };
        if call.id != tool_call_id {
            return fail(
                "EFFECT_MISMATCH",
                "Tool result must follow the completion's original call order",
            );
        }
        let result_ids: Vec<_> = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
                _ => None,
            })
            .collect();
        if result_ids != [tool_call_id]
            || blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolUse { .. }))
        {
            return fail(
                "INVALID_ARGUMENT",
                "Exactly one correlated tool result is required",
            );
        }
        self.append_bytes(&message(Role::User, blocks.to_vec()))?;
        Ok(())
    }

    /// Ordinary adapters can exclude truncated calls and provider-executed
    /// SDK calls before local registry dispatch. Restricted terminal-tool
    /// sessions cannot use this route to skip an outstanding effect.
    pub fn retain_local_calls(&mut self, calls: &[ToolCall]) -> Result<()> {
        self.active()?;
        if self.options.final_tool.is_some() {
            return fail(
                "ACCESS_DENIED",
                "Restricted sessions cannot drop pending tool results",
            );
        }
        let keep: BTreeSet<_> = calls.iter().map(|call| call.id.as_str()).collect();
        let selected: Vec<_> = self
            .pending
            .iter()
            .filter(|call| keep.contains(call.id.as_str()))
            .cloned()
            .collect();
        if selected != calls {
            return fail(
                "EFFECT_MISMATCH",
                "Local calls must retain their original ordered identities",
            );
        }
        self.pending = selected.into();
        if self.pending.is_empty() {
            self.phase = Phase::Finished;
        }
        Ok(())
    }

    pub fn complete_tool(
        &mut self,
        tool_call_id: &str,
        blocks: Vec<ContentBlock>,
    ) -> Result<Message> {
        self.check_result(tool_call_id, &blocks)?;
        let is_error = blocks.iter().any(|block| {
            matches!(
                block,
                ContentBlock::ToolResult {
                    is_error: Some(true),
                    ..
                }
            )
        });
        let terminal = !is_error
            && self.options.final_tool.as_deref()
                == self.pending.front().map(|call| call.name.as_str());
        let result = message(Role::User, blocks);
        self.append(result.clone())?;
        self.pending.pop_front();
        self.phase = if !self.pending.is_empty() {
            Phase::NeedsTools
        } else if terminal {
            Phase::Finished
        } else {
            Phase::Ready
        };
        Ok(result)
    }

    pub fn correct(&mut self, text: &str) -> Result<()> {
        if self.phase != Phase::NeedsCorrection {
            return fail(
                "TURN_PENDING",
                "Corrections require a completed response without tools",
            );
        }
        self.begin_input(text_blocks(text))
    }
    pub fn cancel(&mut self) {
        self.phase = Phase::Cancelled;
        self.pending.clear();
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            format: "jcode-turn/1".into(),
            messages: self.messages.clone(),
            stop_reasons: self.stop_reasons.clone(),
            requests: self.requests,
            tool_calls: self.calls,
            phase: self.phase,
        }
    }

    /// Reconstruct only completed history for a fresh, explicitly authorized
    /// assignment. In-flight provider/tool effects are never automatically replayed.
    pub fn restore_completed(snapshot: Snapshot, options: Options) -> Result<Self> {
        if snapshot.format != "jcode-turn/1"
            || matches!(
                snapshot.phase,
                Phase::AwaitingResponse | Phase::NeedsTools | Phase::Cancelled
            )
        {
            return fail(
                "INVALID_SNAPSHOT",
                "Only fully acknowledged conversation history can be imported",
            );
        }
        let mut replay = Self::new(options);
        let mut responses = 0;
        for stored in &snapshot.messages {
            if stored.timestamp.is_some() || stored.tool_duration_ms.is_some() {
                return fail(
                    "INVALID_SNAPSHOT",
                    "Primitive conversation history contains unrecognized metadata",
                );
            }
            match stored.role {
                Role::Assistant => {
                    let mut prefix = Vec::new();
                    let mut calls = Vec::new();
                    let mut saw_call = false;
                    for block in &stored.content {
                        match block {
                            ContentBlock::ToolUse {
                                id,
                                name,
                                input,
                                thought_signature,
                            } => {
                                saw_call = true;
                                calls.push(ToolCall {
                                    id: id.clone(),
                                    name: name.clone(),
                                    input: input.clone(),
                                    intent: None,
                                    thought_signature: thought_signature.clone(),
                                });
                            }
                            _ if !saw_call => prefix.push(block.clone()),
                            _ => {
                                return fail(
                                    "INVALID_SNAPSHOT",
                                    "Conversation assistant block order is invalid",
                                );
                            }
                        }
                    }
                    let request = replay.request().map_err(|_| TurnError {
                        code: "INVALID_SNAPSHOT",
                        message: "Invalid restored turn ordering",
                    })?;
                    let reason = snapshot
                        .stop_reasons
                        .get(responses)
                        .ok_or(TurnError {
                            code: "INVALID_SNAPSHOT",
                            message: "Missing completion metadata",
                        })?
                        .clone();
                    replay
                        .accept_response(request, prefix, calls, reason)
                        .map_err(|_| TurnError {
                            code: "INVALID_SNAPSHOT",
                            message: "Invalid restored assistant completion",
                        })?;
                    responses += 1;
                }
                Role::User => {
                    let result = stored.content.iter().find_map(|block| match block {
                        ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id),
                        _ => None,
                    });
                    if let Some(id) = result {
                        replay
                            .complete_tool(id, stored.content.clone())
                            .map_err(|_| TurnError {
                                code: "INVALID_SNAPSHOT",
                                message: "Invalid restored tool-result pairing",
                            })?;
                    } else {
                        replay
                            .begin_input(stored.content.clone())
                            .map_err(|_| TurnError {
                                code: "INVALID_SNAPSHOT",
                                message: "Invalid restored user input",
                            })?;
                    }
                }
            }
        }
        if replay.phase != snapshot.phase
            || replay.requests != snapshot.requests
            || replay.calls != snapshot.tool_calls
            || responses != snapshot.stop_reasons.len()
            || serde_json::to_value(&replay.messages).expect("messages")
                != serde_json::to_value(&snapshot.messages).expect("messages")
        {
            return fail(
                "INVALID_SNAPSHOT",
                "Conversation counters or final state do not match its history",
            );
        }
        Ok(replay)
    }
}
