//! A restricted, headless JCode-derived session executor. The build graph has
//! no standard JCode tools, provider credentials, daemon, or spawning facility.
//! The trusted host owns model transport and durable artifact effects; every
//! effect passes this role/ownership/version boundary before the host applies it.

pub mod conversation;
pub mod policy;
pub mod protocol;
pub mod session;
pub mod tools;

use protocol::{EngineError, Request, Response, Result};
use serde_json::{Value, json};
use session::Session;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Engine {
    sessions: BTreeMap<String, Session>,
}

impl Engine {
    pub fn dispatch(&mut self, request: Request) -> Response {
        let id = request.id().to_owned();
        if let Err(error) = policy::identifier(&id) {
            return Response::failure(Some(id), error);
        }
        match self.execute(request) {
            Ok(result) => Response::success(id, result),
            Err(error) => Response::failure(Some(id), error),
        }
    }

    fn session(&mut self, id: &str) -> Result<&mut Session> {
        self.sessions.get_mut(id).ok_or_else(|| {
            EngineError::new(
                "POLICY_REQUIRED",
                "Initialize an explicitly restricted session before executing tools",
            )
        })
    }

    fn execute(&mut self, request: Request) -> Result<Value> {
        match request {
            Request::Init {
                session_id,
                policy,
                state,
                restore,
                ..
            } => {
                if self.sessions.contains_key(&session_id) {
                    return Err(EngineError::new(
                        "SESSION_EXISTS",
                        "An existing session's authority cannot be replaced",
                    ));
                }
                if self.sessions.len() >= 16 {
                    return Err(EngineError::new(
                        "BUDGET_EXCEEDED",
                        "Native process session limit is exhausted",
                    ));
                }
                let session = Session::new(
                    session_id.clone(),
                    policy,
                    state,
                    restore.map(|snapshot| *snapshot),
                )?;
                let acknowledgement = session.acknowledgement();
                self.sessions.insert(session_id, session);
                Ok(acknowledgement)
            }
            Request::Authorize {
                session_id,
                execution_generation,
                tool_call,
                ..
            } => self
                .session(&session_id)?
                .authorize(execution_generation, tool_call),
            Request::Complete {
                session_id,
                execution_generation,
                tool_call_id,
                result,
                is_error,
                state,
                ..
            } => self.session(&session_id)?.complete(
                execution_generation,
                &tool_call_id,
                result,
                is_error,
                state,
            ),
            Request::Snapshot { session_id, .. } => {
                Ok(serde_json::to_value(self.session(&session_id)?.snapshot()?)
                    .expect("serializable restricted snapshot"))
            }
            Request::Cancel {
                session_id,
                execution_generation,
                ..
            } => self.session(&session_id)?.cancel(execution_generation),
            Request::TurnBegin {
                session_id,
                execution_generation,
                system_prompt,
                input,
                prior,
                ..
            } => self.session(&session_id)?.turn_begin(
                execution_generation,
                system_prompt,
                input,
                prior.map(|prior| *prior),
            ),
            Request::TurnRequest {
                session_id,
                execution_generation,
                ..
            } => self
                .session(&session_id)?
                .turn_request(execution_generation),
            Request::TurnResponse {
                session_id,
                execution_generation,
                request_id,
                message,
                stop_reason,
                ..
            } => self.session(&session_id)?.turn_response(
                execution_generation,
                &request_id,
                message,
                stop_reason,
            ),
            Request::TurnCorrection {
                session_id,
                execution_generation,
                content,
                ..
            } => self
                .session(&session_id)?
                .turn_correction(execution_generation, &content),
            Request::Reject {
                session_id,
                execution_generation,
                tool_call_id,
                result,
                ..
            } => self
                .session(&session_id)?
                .reject(execution_generation, &tool_call_id, result),
        }
    }
}

pub fn version() -> Value {
    json!({"name":"jcode-primitive","version":env!("CARGO_PKG_VERSION"),
        "engine_protocol":protocol::ENGINE_PROTOCOL,"policy_revision":protocol::POLICY_REVISION,
        "upstream_release":"v0.99.0","upstream_commit":protocol::UPSTREAM_COMMIT,
        "source_revision":option_env!("PRIMITIVE_ENGINE_SOURCE_REVISION").unwrap_or("unreleased-source"),
        "restricted_mode":true,"ambient_credentials":false,"ordinary_tools":false,
        "ordinary_turn_core":"jcode-turn/1",
        "turn_core_protocol":"jcode-turn/1","shared_ordinary_turn_core":true,
        "native_sandbox":false,"filesystem_effects":"host-mediated-only"})
}
