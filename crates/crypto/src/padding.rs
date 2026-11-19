//! Fixed-size padding for message plaintexts.
//!
//! Plaintexts are padded up to one of a few bucket sizes before they are
//! encrypted, so ciphertext length only reveals which bucket a message fell
//! into. The layout is a 4-byte big-endian length, the content, then zeros.

use crate::CryptoError;

/// Padded sizes in bytes, smallest first. Anything larger is rejected.
pub const BUCKETS: [usize; 5] = [256, 1024, 4096, 16384, 65536];

const LEN_PREFIX: usize = 4;

/// Largest content that fits in the biggest bucket.
pub const MAX_CONTENT: usize = BUCKETS[BUCKETS.len() - 1] - LEN_PREFIX;

/// Pads `content` up to the smallest bucket that holds it.
pub fn pad(content: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let needed = content.len() + LEN_PREFIX;
    let size = BUCKETS
        .iter()
        .copied()
        .find(|&b| b >= needed)
        .ok_or(CryptoError::MessageTooLarge)?;
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&(content.len() as u32).to_be_bytes());
    out.extend_from_slice(content);
    out.resize(size, 0);
    Ok(out)
}

/// Strips padding added by [`pad`]. Rejects anything that isn't exactly a
/// bucket size or whose length prefix doesn't fit.
pub fn unpad(padded: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if !BUCKETS.contains(&padded.len()) {
        return Err(CryptoError::Malformed);
    }
    let len = u32::from_be_bytes(padded[..LEN_PREFIX].try_into().unwrap()) as usize;
    if len > padded.len() - LEN_PREFIX {
        return Err(CryptoError::Malformed);
    }
    Ok(padded[LEN_PREFIX..LEN_PREFIX + len].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_uses_smallest_bucket() {
        for (len, bucket) in [(0, 256), (252, 256), (253, 1024), (5000, 16384)] {
            let msg = vec![7u8; len];
            let padded = pad(&msg).unwrap();
            assert_eq!(padded.len(), bucket);
            assert_eq!(unpad(&padded).unwrap(), msg);
        }
    }

    #[test]
    fn rejects_oversized_content() {
        assert_eq!(pad(&vec![0; MAX_CONTENT + 1]), Err(CryptoError::MessageTooLarge));
        assert!(pad(&vec![0; MAX_CONTENT]).is_ok());
    }

    #[test]
    fn rejects_bad_padding() {
        assert_eq!(unpad(&[0; 100]), Err(CryptoError::Malformed));
        let mut padded = pad(b"hi").unwrap();
        padded[..4].copy_from_slice(&1000u32.to_be_bytes());
        assert_eq!(unpad(&padded), Err(CryptoError::Malformed));
    }
}
