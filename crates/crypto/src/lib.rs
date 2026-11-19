//! Bastion encryption core.
//!
//! Message padding and safety codes. Group key management on OpenMLS
//! comes next.

pub mod padding;
pub mod safety;

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
}

impl core::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CryptoError::MessageTooLarge => f.write_str("message too large"),
            CryptoError::Malformed => f.write_str("malformed input"),
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
