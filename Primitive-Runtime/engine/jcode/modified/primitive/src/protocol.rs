use crate::{
    conversation::{Assistant, ConversationSnapshot},
    policy::{ArtifactState, Policy},
    session::SessionSnapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ENGINE_PROTOCOL: &str = "primitive-engine/1";
pub const POLICY_REVISION: &str = "primitive-policy/1";
pub const UPSTREAM_COMMIT: &str = "774613c90751b6a26ae9eb6a27be6aff3f210062";
pub const MAX_FRAME_BYTES: usize = 20 * 1024 * 1024;

/// A strict wire representation; conversion reuses JCode's ordinary ToolCall.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WireToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

impl From<WireToolCall> for jcode_message_types::ToolCall {
    fn from(call: WireToolCall) -> Self {
        Self {
            id: call.id,
            name: call.name,
            input: call.input,
            intent: None,
            thought_signature: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Init {
        id: String,
        session_id: String,
        policy: Policy,
        state: ArtifactState,
        #[serde(default)]
        restore: Option<Box<SessionSnapshot>>,
    },
    Authorize {
        id: String,
        session_id: String,
        execution_generation: u64,
        tool_call: WireToolCall,
    },
    Complete {
        id: String,
        session_id: String,
        execution_generation: u64,
        tool_call_id: String,
        result: Value,
        is_error: bool,
        state: ArtifactState,
    },
    Snapshot {
        id: String,
        session_id: String,
    },
    Cancel {
        id: String,
        session_id: String,
        execution_generation: u64,
    },
    TurnBegin {
        id: String,
        session_id: String,
        execution_generation: u64,
        system_prompt: String,
        input: String,
        #[serde(default)]
        prior: Option<Box<ConversationSnapshot>>,
    },
    TurnRequest {
        id: String,
        session_id: String,
        execution_generation: u64,
    },
    TurnResponse {
        id: String,
        session_id: String,
        execution_generation: u64,
        request_id: String,
        message: Assistant,
        #[serde(default)]
        stop_reason: Option<String>,
    },
    TurnCorrection {
        id: String,
        session_id: String,
        execution_generation: u64,
        content: String,
    },
    Reject {
        id: String,
        session_id: String,
        execution_generation: u64,
        tool_call_id: String,
        result: Value,
    },
}

impl Request {
    pub fn id(&self) -> &str {
        match self {
            Self::Init { id, .. }
            | Self::Authorize { id, .. }
            | Self::Complete { id, .. }
            | Self::Snapshot { id, .. }
            | Self::Cancel { id, .. }
            | Self::TurnBegin { id, .. }
            | Self::TurnRequest { id, .. }
            | Self::TurnResponse { id, .. }
            | Self::TurnCorrection { id, .. }
            | Self::Reject { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EngineError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl EngineError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
            retryable: false,
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for EngineError {}
pub type Result<T> = std::result::Result<T, EngineError>;

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<EngineError>,
}

impl Response {
    pub fn success(id: String, result: Value) -> Self {
        Self {
            id: Some(id),
            ok: true,
            result: Some(result),
            error: None,
        }
    }
    pub fn failure(id: Option<String>, error: EngineError) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}
