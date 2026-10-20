use crate::policy::{ArtifactState, Policy, content_hash, identifier};
use crate::protocol::{ENGINE_PROTOCOL, EngineError, MAX_FRAME_BYTES, Result, WireToolCall};
use crate::tools::{self, Effect};
use jcode_message_types::{ContentBlock, Message, Role as MessageRole, ToolCall};
use jcode_session_types::SessionStatus;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSnapshot {
    pub engine_protocol: String,
    pub session_id: String,
    pub policy: Policy,
    pub policy_hash: String,
    pub initial_state: ArtifactState,
    pub state: ArtifactState,
    pub completed_states: Vec<ArtifactState>,
    pub tool_calls: u64,
    pub charged_bytes: u64,
    pub seen_tool_ids: Vec<String>,
    pub transcript: Vec<Message>,
    pub status: SessionStatus,
    pub pending: Option<ToolCall>,
    pub cancelled: bool,
    pub finished: bool,
    #[serde(default)]
    pub conversation: Option<ConversationSnapshot>,
}

struct Pending {
    call: ToolCall,
    effect: Effect,
}

pub(crate) struct Session {
    session_id: String,
    policy: Policy,
    policy_hash: String,
    initial_state: ArtifactState,
    state: ArtifactState,
    completed_states: Vec<ArtifactState>,
    tool_calls: u64,
    charged_bytes: u64,
    seen_tool_ids: BTreeSet<String>,
    transcript: Vec<Message>,
    status: SessionStatus,
    pending: Option<Pending>,
    cancelled: bool,
    finished: bool,
    conversation: Option<Conversation>,
}

impl Session {
    pub(crate) fn new(
        session_id: String,
        policy: Policy,
        state: ArtifactState,
        restore: Option<SessionSnapshot>,
    ) -> Result<Self> {
        identifier(&session_id)?;
        policy.validate(&state)?;
        let policy_hash = policy.hash();
        let initial_bytes = serde_json::to_vec(
            &json!({"session_id":session_id,"policy":policy,"state":state,"initial_state":state}),
        )
        .expect("serializable initialization")
        .len() as u64
            + 256;
        if initial_bytes > policy.max_payload_bytes {
            return Err(EngineError::new(
                "BUDGET_EXCEEDED",
                "The policy manifest exceeds the session byte budget",
            ));
        }
        let mut session = Self {
            session_id,
            policy,
            policy_hash,
            initial_state: state.clone(),
            state,
            completed_states: Vec::new(),
            tool_calls: 0,
            charged_bytes: initial_bytes,
            seen_tool_ids: BTreeSet::new(),
            transcript: Vec::new(),
            status: SessionStatus::Active,
            pending: None,
            cancelled: false,
            finished: false,
            conversation: None,
        };
        if let Some(old) = restore {
            // Restore is an operator-side operation, never a model tool. A
            // stored transcript cannot recover into JCode's default tool set.
            if old.engine_protocol != ENGINE_PROTOCOL
                || old.session_id != session.session_id
                || old.policy_hash != old.policy.hash()
                || !session.policy.same_authority(&old.policy)
            {
                return Err(EngineError::new(
                    "POLICY_MISMATCH",
                    "Restoration requires an identical explicitly reauthorized restricted policy",
                ));
            }
            old.policy.validate(&old.state)?;
            if session.policy.execution_generation <= old.policy.execution_generation {
                return Err(EngineError::new(
                    "STALE_GENERATION",
                    "Restoration requires a strictly newer execution generation",
                ));
            }
            if old.cancelled || old.finished || !matches!(old.status, SessionStatus::Active) {
                return Err(EngineError::new(
                    "SESSION_TERMINAL",
                    "A cancelled or completed session cannot be restored",
                ));
            }
            if old.pending.is_some() {
                return Err(EngineError::new(
                    "RECOVERY_REQUIRED",
                    "A session with an unacknowledged effect cannot be automatically restored",
                ));
            }
            if old.state != session.state {
                return Err(EngineError::new(
                    "PATCH_CONFLICT",
                    "Restored artifact state differs from the durable session snapshot",
                ));
            }
            let seen: BTreeSet<_> = old.seen_tool_ids.iter().cloned().collect();
            if seen.len() != old.seen_tool_ids.len()
                || seen.len() as u64 != old.tool_calls
                || old.tool_calls > session.policy.max_tool_calls
                || old.charged_bytes > session.policy.max_payload_bytes
                || old.transcript.len() as u64 > old.tool_calls.saturating_mul(2)
            {
                return Err(EngineError::new(
                    "INVALID_SNAPSHOT",
                    "Snapshot counters or transcript bounds are inconsistent",
                ));
            }
            for id in &seen {
                identifier(id)?;
            }
            Self::validate_history(&old, &seen)?;
            session.tool_calls = old.tool_calls;
            session.charged_bytes = old.charged_bytes;
            session.seen_tool_ids = seen;
            session.transcript = old.transcript;
            session.initial_state = old.initial_state;
            session.completed_states = old.completed_states;
            if let Some(prior) = old.conversation {
                session.conversation = Some(Conversation::new(
                    &session.session_id,
                    &session.policy,
                    prior.system_prompt.clone(),
                    None,
                    Some(prior),
                )?);
            }
        }
        Ok(session)
    }

    /// Re-run recorded pairs through the same policy/effect transition code.
    /// A stored transcript is evidence to validate, never restored authority.
    fn validate_history(old: &SessionSnapshot, seen: &BTreeSet<String>) -> Result<()> {
        let invalid = || {
            EngineError::new(
                "INVALID_SNAPSHOT",
                "Snapshot transcript, artifact transitions, identifiers or byte counters are inconsistent",
            )
        };
        if old.transcript.len() != old.completed_states.len().saturating_mul(2) {
            return Err(invalid());
        }
        // Generations can gain decimal digits on restore. Use the shortest
        // valid generation solely to derive a conservative original byte floor.
        let mut replay_policy = old.policy.clone();
        replay_policy.execution_generation = 1;
        let mut replay = Self::new(
            old.session_id.clone(),
            replay_policy,
            old.initial_state.clone(),
            None,
        )
        .map_err(|_| invalid())?;
        for (pair, state) in old.transcript.chunks_exact(2).zip(&old.completed_states) {
            let [
                ContentBlock::ToolUse {
                    id,
                    name,
                    input,
                    thought_signature: None,
                },
            ] = pair[0].content.as_slice()
            else {
                return Err(invalid());
            };
            let [
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error: Some(is_error),
                },
            ] = pair[1].content.as_slice()
            else {
                return Err(invalid());
            };
            if !matches!(pair[0].role, MessageRole::Assistant)
                || !matches!(pair[1].role, MessageRole::User)
                || pair.iter().any(|message| {
                    message.timestamp.is_some() || message.tool_duration_ms.is_some()
                })
                || id != tool_use_id
                || !seen.contains(id)
            {
                return Err(invalid());
            }
            replay
                .authorize(
                    1,
                    WireToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    },
                )
                .map_err(|_| invalid())?;
            let result: Value = serde_json::from_str(content).map_err(|_| invalid())?;
            replay
                .complete(1, id, result, *is_error, state.clone())
                .map_err(|_| invalid())?;
        }
        if replay.state != old.state
            || replay.finished != old.finished
            || serde_json::to_value(&replay.transcript).expect("serializable transcript")
                != serde_json::to_value(&old.transcript).expect("serializable transcript")
        {
            return Err(invalid());
        }
        // Rejected authorization attempts consume IDs and bytes but produce
        // no transcript pair. Their shortest possible encoded call is a floor.
        let mut minimum = replay.charged_bytes;
        for id in seen.difference(&replay.seen_tool_ids) {
            let wire = WireToolCall {
                id: id.clone(),
                name: String::new(),
                input: json!(0),
            };
            minimum = minimum
                .checked_add(Self::authorization_bytes(&wire) as u64)
                .ok_or_else(invalid)?;
        }
        if old.charged_bytes < minimum {
            return Err(invalid());
        }
        Ok(())
    }

    fn tool_message(call: &WireToolCall) -> Message {
        Message {
            role: MessageRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
                thought_signature: None,
            }],
            timestamp: None,
            tool_duration_ms: None,
        }
    }

    fn authorization_bytes(call: &WireToolCall) -> usize {
        serde_json::to_vec(&Self::tool_message(call))
            .expect("serializable tool message")
            .len()
            + serde_json::to_vec(&call.id)
                .expect("serializable identifier")
                .len()
            + 2
    }

    pub(crate) fn acknowledgement(&self) -> Value {
        json!({"policy_ack":true,"policy_hash":self.policy_hash,"engine_protocol":ENGINE_PROTOCOL,
            "execution_generation":self.policy.execution_generation,"tools":tools::definitions(self.policy.role),"turn_protocol":"jcode-turn/1",
            "turn_core_protocol":"jcode-turn/1","shared_ordinary_turn_core":true})
    }

    fn generation(&self, generation: u64) -> Result<()> {
        if self.cancelled {
            return Err(EngineError::new(
                "CANCELLED",
                "The session has acknowledged cancellation",
            ));
        }
        if generation != self.policy.execution_generation {
            return Err(EngineError::new(
                "STALE_GENERATION",
                "Callback belongs to a different execution generation",
            ));
        }
        if self.finished {
            return Err(EngineError::new(
                "SESSION_TERMINAL",
                "The local assignment has already finished",
            ));
        }
        Ok(())
    }

    fn charge(&mut self, bytes: usize) -> Result<()> {
        let next = self
            .charged_bytes
            .checked_add(bytes as u64)
            .ok_or_else(|| {
                EngineError::new("BUDGET_EXCEEDED", "Session byte budget is exhausted")
            })?;
        if next > self.policy.max_payload_bytes {
            return Err(EngineError::new(
                "BUDGET_EXCEEDED",
                "Session byte budget is exhausted",
            ));
        }
        self.charged_bytes = next;
        Ok(())
    }

    pub(crate) fn authorize(&mut self, generation: u64, wire: WireToolCall) -> Result<Value> {
        self.generation(generation)?;
        identifier(&wire.id)?;
        if self.pending.is_some() {
            return Err(EngineError::new(
                "EFFECT_PENDING",
                "The previous tool effect must be acknowledged before another authorization",
            ));
        }
        if self.seen_tool_ids.contains(&wire.id) {
            return Err(EngineError::new(
                "DUPLICATE_TOOL_CALL",
                "A tool call identifier cannot be executed twice",
            ));
        }
        if let Some(conversation) = &self.conversation {
            conversation.match_call(&wire)?;
        }
        if self.tool_calls >= self.policy.max_tool_calls {
            return Err(EngineError::new(
                "BUDGET_EXCEEDED",
                "Session tool-call budget is exhausted",
            ));
        }
        self.charge(Self::authorization_bytes(&wire))?;
        self.seen_tool_ids.insert(wire.id.clone());
        self.tool_calls += 1;
        let call: ToolCall = wire.clone().into();
        // Invalid attempts consume their id and budget; retrying a rejected
        // model action cannot turn it into an authorized duplicate effect.
        let effect = tools::check(&self.policy, &self.state, &call)?;
        self.transcript.push(Self::tool_message(&wire));
        self.pending = Some(Pending { call, effect });
        Ok(
            json!({"authorized":true,"action":wire,"policy_hash":self.policy_hash,
            "execution_generation":self.policy.execution_generation}),
        )
    }

    pub(crate) fn complete(
        &mut self,
        generation: u64,
        call_id: &str,
        result: Value,
        is_error: bool,
        state: ArtifactState,
    ) -> Result<Value> {
        self.generation(generation)?;
        state.validate()?;
        let pending = self.pending.as_ref().ok_or_else(|| {
            EngineError::new(
                "NO_PENDING_EFFECT",
                "No authorized tool effect is awaiting acknowledgement",
            )
        })?;
        if pending.call.id != call_id {
            return Err(EngineError::new(
                "EFFECT_MISMATCH",
                "Tool result does not match the authorized effect",
            ));
        }
        if let Some(conversation) = &self.conversation {
            conversation.check_result(call_id, &result, is_error)?;
        }
        if state.inbox_cursor < self.state.inbox_cursor {
            return Err(EngineError::new(
                "INBOX_CONFLICT",
                "Processed inbox watermark cannot move backwards",
            ));
        }
        let mut expected_hash = self.state.artifact_hash.clone();
        let mut expected_version = self.state.artifact_version;
        if !is_error {
            if let Effect::Write { content } = &pending.effect {
                expected_hash = content.as_deref().map(content_hash);
                expected_version = expected_version.checked_add(1).ok_or_else(|| {
                    EngineError::new("BUDGET_EXCEEDED", "Artifact version counter is exhausted")
                })?;
            }
            if matches!(pending.effect, Effect::Finish)
                && state.inbox_cursor != self.state.inbox_cursor
            {
                return Err(EngineError::new(
                    "INBOX_CONFLICT",
                    "A new message arrived during completion; the assignment must remain runnable",
                ));
            }
        }
        if state.artifact_hash != expected_hash || state.artifact_version != expected_version {
            return Err(EngineError::new(
                "PATCH_CONFLICT",
                "Tool acknowledgement changed an unauthorized artifact identity",
            ));
        }
        let finish = !is_error && matches!(pending.effect, Effect::Finish);
        let serialized_result = serde_json::to_string(&result).expect("serializable tool result");
        let message = Message {
            role: MessageRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: call_id.to_owned(),
                content: serialized_result,
                is_error: Some(is_error),
            }],
            timestamp: None,
            tool_duration_ms: None,
        };
        // Charge the stored JSON string, including its second escaping layer.
        // This bounds durable snapshots, not merely raw provider result bytes.
        self.charge(
            serde_json::to_vec(&message)
                .expect("serializable tool result message")
                .len()
                + serde_json::to_vec(&state)
                    .expect("serializable state")
                    .len()
                + 2,
        )?;
        if let Some(conversation) = &mut self.conversation {
            conversation.result(call_id, &result, is_error)?;
        }
        self.transcript.push(message);
        self.completed_states.push(state.clone());
        self.state = state;
        self.pending = None;
        if finish {
            self.finished = true;
            self.status = SessionStatus::Closed;
        }
        Ok(
            json!({"acknowledged":true,"state":self.state,"finished":self.finished,
            "tool_calls":self.tool_calls,"charged_bytes":self.charged_bytes}),
        )
    }

    pub(crate) fn cancel(&mut self, generation: u64) -> Result<Value> {
        if generation != self.policy.execution_generation {
            return Err(EngineError::new(
                "STALE_GENERATION",
                "Cancellation belongs to a different execution generation",
            ));
        }
        // Cancellation is idempotent even after a completed assignment. The
        // host must separately fence durable effects and abort model requests.
        self.cancelled = true;
        self.pending = None;
        self.status = SessionStatus::Closed;
        if let Some(conversation) = &mut self.conversation {
            conversation.cancel();
        }
        Ok(json!({"cancelled":true,"cleanup_ack":true,"execution_generation":generation}))
    }

    pub(crate) fn turn_begin(
        &mut self,
        generation: u64,
        system_prompt: String,
        input: String,
        prior: Option<ConversationSnapshot>,
    ) -> Result<Value> {
        self.generation(generation)?;
        if self.conversation.is_some() || self.tool_calls != 0 || self.pending.is_some() {
            return Err(EngineError::new(
                "SESSION_EXISTS",
                "Conversation must begin once, before any policy effects",
            ));
        }
        self.charge(system_prompt.len().saturating_add(input.len()))?;
        self.conversation = Some(Conversation::new(
            &self.session_id,
            &self.policy,
            system_prompt,
            Some(input),
            prior,
        )?);
        Ok(json!({"ready":true,"turn_protocol":"jcode-turn/1"}))
    }
    fn conversation(&mut self) -> Result<&mut Conversation> {
        self.conversation.as_mut().ok_or_else(|| {
            EngineError::new(
                "TURN_REQUIRED",
                "Begin an ordinary JCode conversation before requesting model work",
            )
        })
    }
    pub(crate) fn turn_request(&mut self, generation: u64) -> Result<Value> {
        self.generation(generation)?;
        self.conversation()?.request()
    }
    pub(crate) fn turn_response(
        &mut self,
        generation: u64,
        request_id: &str,
        message: Assistant,
        stop_reason: Option<String>,
    ) -> Result<Value> {
        self.generation(generation)?;
        self.charge(
            serde_json::to_vec(&message)
                .expect("provider response")
                .len(),
        )?;
        self.conversation()?
            .response(request_id, message, stop_reason)
    }
    pub(crate) fn turn_correction(&mut self, generation: u64, content: &str) -> Result<Value> {
        self.generation(generation)?;
        self.charge(content.len())?;
        self.conversation()?.correction(content)?;
        Ok(json!({"ready":true}))
    }
    pub(crate) fn reject(
        &mut self,
        generation: u64,
        call_id: &str,
        result: Value,
    ) -> Result<Value> {
        self.generation(generation)?;
        if self.pending.is_some() {
            return Err(EngineError::new(
                "EFFECT_PENDING",
                "An authorized effect requires complete, not reject",
            ));
        }
        let call = self.conversation()?.pending()?;
        if call.id != call_id {
            return Err(EngineError::new(
                "EFFECT_MISMATCH",
                "Rejection does not match the pending completion call",
            ));
        }
        self.conversation()?.check_result(call_id, &result, true)?;
        if !self.seen_tool_ids.contains(call_id) {
            if self.tool_calls >= self.policy.max_tool_calls {
                return Err(EngineError::new(
                    "BUDGET_EXCEEDED",
                    "Session tool-call budget is exhausted",
                ));
            }
            self.charge(Self::authorization_bytes(&call))?;
            self.seen_tool_ids.insert(call_id.into());
            self.tool_calls += 1;
        }
        self.charge(
            serde_json::to_vec(&Conversation::result_blocks(call_id, &result, true))
                .expect("tool rejection")
                .len(),
        )?;
        self.conversation()?.result(call_id, &result, true)?;
        Ok(json!({"acknowledged":true,"is_error":true,"state":self.state}))
    }

    pub(crate) fn snapshot(&self) -> Result<SessionSnapshot> {
        let snapshot = SessionSnapshot {
            engine_protocol: ENGINE_PROTOCOL.to_owned(),
            session_id: self.session_id.clone(),
            policy: self.policy.clone(),
            policy_hash: self.policy_hash.clone(),
            initial_state: self.initial_state.clone(),
            state: self.state.clone(),
            completed_states: self.completed_states.clone(),
            tool_calls: self.tool_calls,
            charged_bytes: self.charged_bytes,
            seen_tool_ids: self.seen_tool_ids.iter().cloned().collect(),
            transcript: self.transcript.clone(),
            status: self.status.clone(),
            pending: self.pending.as_ref().map(|p| p.call.clone()),
            cancelled: self.cancelled,
            finished: self.finished,
            conversation: self.conversation.as_ref().map(Conversation::snapshot),
        };
        let bytes = serde_json::to_vec(&snapshot)
            .expect("serializable snapshot")
            .len();
        // The host accepts a 16 MiB snapshot plus the response envelope. An
        // init request also repeats the manifest and must fit the input frame.
        let restore_bytes = serde_json::to_vec(&json!({
            "op":"init", "id":"x".repeat(256), "session_id":self.session_id,
            "policy":self.policy, "state":self.state, "restore":snapshot,
        }))
        .expect("serializable restore envelope")
        .len();
        if bytes > 16 * 1024 * 1024 || restore_bytes.saturating_add(32) > MAX_FRAME_BYTES {
            return Err(EngineError::new(
                "BUDGET_EXCEEDED",
                "Serialized snapshot or its restoration envelope exceeds the native frame limit",
            ));
        }
        Ok(snapshot)
    }
}
use crate::conversation::{Assistant, Conversation, ConversationSnapshot};
