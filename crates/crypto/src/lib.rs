//! Bastion encryption core.
//!
//! This crate will wrap OpenMLS and expose group key management and message
//! encryption to the web and desktop clients through WASM. It is a stub for
//! now: only the version marker and error type exist.

/// MLS protocol version the core targets (RFC 9420).
pub const MLS_PROTOCOL_VERSION: &str = "mls10";

/// Errors surfaced by the encryption core.
#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// The requested operation is not implemented yet.
    NotImplemented,
}

impl core::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CryptoError::NotImplemented => f.write_str("not implemented"),
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
