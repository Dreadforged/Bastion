//! Safety codes for verifying a conversation partner out of band.
//!
//! Each side gets a 30-digit fingerprint of its user id and identity key,
//! made by iterating SHA-256 so brute-forcing a colliding key is costly.
//! The two fingerprints are sorted and joined, so both people see the same
//! 60 digits, shown as twelve groups of five.

use sha2::{Digest, Sha256};

const VERSION: &[u8] = b"bastion-safety-v1";
const ITERATIONS: usize = 5200;

fn fingerprint(user_id: &[u8], identity_key: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(VERSION);
    hasher.update((user_id.len() as u32).to_be_bytes());
    hasher.update(user_id);
    hasher.update(identity_key);
    let mut hash = hasher.finalize();
    for _ in 1..ITERATIONS {
        let mut h = Sha256::new();
        h.update(hash);
        h.update(identity_key);
        hash = h.finalize();
    }
    // Six 5-byte chunks, each reduced to five decimal digits.
    hash[..30]
        .chunks(5)
        .map(|c| {
            let n = c.iter().fold(0u64, |acc, &b| (acc << 8) | b as u64);
            format!("{:05}", n % 100_000)
        })
        .collect()
}

/// Returns the shared safety code for two parties, as twelve space-separated
/// groups of five digits. Argument order doesn't matter.
pub fn safety_code(a_user: &[u8], a_key: &[u8], b_user: &[u8], b_key: &[u8]) -> String {
    let mut parts = [fingerprint(a_user, a_key), fingerprint(b_user, b_key)];
    parts.sort();
    let digits = parts.concat();
    digits
        .as_bytes()
        .chunks(5)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_code_from_both_sides() {
        let a = safety_code(b"alice", &[1; 32], b"bob", &[2; 32]);
        let b = safety_code(b"bob", &[2; 32], b"alice", &[1; 32]);
        assert_eq!(a, b);
        assert_eq!(a.len(), 60 + 11);
        assert!(a
            .split(' ')
            .all(|g| g.len() == 5 && g.bytes().all(|c| c.is_ascii_digit())));
    }

    #[test]
    fn changes_when_a_key_changes() {
        let a = safety_code(b"alice", &[1; 32], b"bob", &[2; 32]);
        let b = safety_code(b"alice", &[1; 32], b"bob", &[3; 32]);
        assert_ne!(a, b);
    }
}
