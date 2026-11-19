//! Bastion encryption core.
//!
//! Wraps OpenMLS to give each device group key management and message
//! encryption. The server only ever sees the TLS-encoded MLS messages this
//! crate produces; it orders and stores them but can't read them.

pub mod client;
pub mod padding;
pub mod safety;

pub use client::{Client, CommitOut, Incoming};
pub use safety::safety_code;

/// MLS protocol version the core targets (RFC 9420).
pub const MLS_PROTOCOL_VERSION: &str = "mls10";

/// Errors surfaced by the encryption core.
#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// Content is too large for the biggest padding bucket.
    MessageTooLarge,
    /// Input bytes couldn't be decoded.
    Malformed,
    /// This device has no state for the group.
    UnknownGroup,
    /// A named member isn't in the group.
    NotAMember,
    /// OpenMLS rejected the operation.
    Mls(String),
}

impl core::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CryptoError::MessageTooLarge => f.write_str("message too large"),
            CryptoError::Malformed => f.write_str("malformed input"),
            CryptoError::UnknownGroup => f.write_str("unknown group"),
            CryptoError::NotAMember => f.write_str("not a member"),
            CryptoError::Mls(e) => write!(f, "mls: {e}"),
        }
    }
}

impl std::error::Error for CryptoError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_mls_1_0() {
        assert_eq!(MLS_PROTOCOL_VERSION, "mls10");
    }
}
