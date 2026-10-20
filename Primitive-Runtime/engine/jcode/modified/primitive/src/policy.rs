use crate::protocol::{EngineError, POLICY_REVISION, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const MAX_SESSION_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_TOOL_CALLS: u64 = 10_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Activator,
    Primitive,
    Diagnosis,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub run_id: String,
    pub role: Role,
    pub artifact_path: Option<String>,
    pub allowed_dependencies: Vec<String>,
    pub execution_generation: u64,
    pub policy_revision: String,
    pub max_tool_calls: u64,
    pub max_payload_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactState {
    pub artifact_hash: Option<String>,
    pub artifact_version: u64,
    pub inbox_cursor: u64,
}

pub fn content_hash(content: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(content.as_bytes()))
}

pub fn identifier(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(EngineError::new(
            "INVALID_ARGUMENT",
            "Identifiers must be nonempty bounded strings without control characters",
        ));
    }
    Ok(())
}

/// Portable lexical identity. The host artifact service additionally checks
/// real filesystem identity, symlinks, hard links, junctions, and snapshot hashes.
pub fn canonical_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 4096
        || path.starts_with('/')
        || path
            .chars()
            .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
    {
        return Err(EngineError::new(
            "INVALID_PATH",
            "Artifact paths must be canonical repository-relative paths",
        ));
    }
    for part in path.split('/') {
        let upper = part.to_ascii_uppercase();
        let stem = upper.split('.').next().unwrap_or("");
        let device = ["CON", "PRN", "AUX", "NUL"].contains(&stem)
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.eq_ignore_ascii_case(".git")
            || part.ends_with(' ')
            || part.ends_with('.')
            || device
        {
            return Err(EngineError::new(
                "INVALID_PATH",
                "Artifact path contains an unsafe or platform-aliased component",
            ));
        }
    }
    Ok(())
}

impl ArtifactState {
    pub fn validate(&self) -> Result<()> {
        if let Some(hash) = &self.artifact_hash {
            let Some(hex) = hash.strip_prefix("sha256:") else {
                return Err(EngineError::new(
                    "INVALID_STATE",
                    "Artifact hashes must use the sha256 algorithm",
                ));
            };
            if hex.len() != 64
                || !hex
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(EngineError::new(
                    "INVALID_STATE",
                    "Artifact hash is not a lowercase SHA-256 digest",
                ));
            }
        }
        Ok(())
    }
}

impl Policy {
    pub fn validate(&self, state: &ArtifactState) -> Result<()> {
        identifier(&self.run_id)?;
        if self.policy_revision != POLICY_REVISION {
            return Err(EngineError::new(
                "POLICY_MISMATCH",
                "An explicit supported restricted policy revision is required",
            ));
        }
        if self.execution_generation == 0
            || self.max_tool_calls == 0
            || self.max_tool_calls > MAX_TOOL_CALLS
            || self.max_payload_bytes == 0
            || self.max_payload_bytes > MAX_SESSION_BYTES
        {
            return Err(EngineError::new(
                "INVALID_POLICY",
                "Policy generation and execution limits are outside supported bounds",
            ));
        }
        match (&self.role, &self.artifact_path) {
            (Role::Primitive, Some(path)) => canonical_path(path)?,
            (Role::Primitive, None) => {
                return Err(EngineError::new(
                    "INVALID_POLICY",
                    "A primitive must own exactly one artifact",
                ));
            }
            (_, Some(_)) => {
                return Err(EngineError::new(
                    "INVALID_POLICY",
                    "Read-only roles cannot own an artifact",
                ));
            }
            (_, None) => {
                if state.artifact_hash.is_some() || state.artifact_version != 0 {
                    return Err(EngineError::new(
                        "INVALID_STATE",
                        "Read-only sessions cannot carry owned-artifact state",
                    ));
                }
            }
        }
        if self.allowed_dependencies.len() > 100_000 {
            return Err(EngineError::new(
                "INVALID_POLICY",
                "Dependency manifest is too large",
            ));
        }
        let mut identities = BTreeSet::new();
        for path in &self.allowed_dependencies {
            canonical_path(path)?;
            if !identities.insert(path.to_lowercase()) {
                return Err(EngineError::new(
                    "INVALID_POLICY",
                    "Dependency paths contain duplicate or case-aliased identities",
                ));
            }
        }
        state.validate()
    }

    pub fn hash(&self) -> String {
        // Struct field order is stable. Callers pin the exact policy, including
        // generation and manifest; no model-visible override can change it.
        let bytes = serde_json::to_vec(self).expect("serializable policy");
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    pub fn permits_read(&self, path: &str) -> bool {
        self.artifact_path.as_deref() == Some(path)
            || self.allowed_dependencies.iter().any(|p| p == path)
    }

    pub fn same_authority(&self, previous: &Self) -> bool {
        let mut old = previous.clone();
        old.execution_generation = self.execution_generation;
        self == &old
    }
}
