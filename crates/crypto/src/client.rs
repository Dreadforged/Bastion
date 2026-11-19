//! One device's view of its MLS groups.
//!
//! A [`Client`] owns a device's signing key and credential plus the state of
//! every group it is in. It produces key packages for the server to hand out,
//! creates groups, adds and removes members, and encrypts and decrypts
//! application messages. All wire values are plain byte vectors in TLS
//! encoding so they can be passed through WASM and the server untouched.
//!
//! Commits the client makes are held as pending until the delivery service
//! accepts them; call [`Client::commit_accepted`] or
//! [`Client::commit_rejected`] once the server answers.

use std::collections::HashMap;

use openmls::prelude::{
    tls_codec::{Deserialize as _, Serialize as _},
    *,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

use crate::{padding, CryptoError};

/// X25519, AES-128-GCM, SHA-256, Ed25519.
pub const CIPHERSUITE: Ciphersuite =
    Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// Result of a commit the client created: the commit for the group and, when
/// members were added, the welcome for the new members.
#[derive(Debug, Clone)]
pub struct CommitOut {
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
}

/// What an incoming group message turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    /// An application message, with padding removed.
    Message { sender: Vec<u8>, content: Vec<u8> },
    /// A commit from another member was applied; the group is now at `epoch`.
    Commit { epoch: u64 },
    /// A commit removed this device from the group.
    Removed,
}

fn mls_err(e: impl core::fmt::Debug) -> CryptoError {
    CryptoError::Mls(format!("{e:?}"))
}

pub struct Client {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    groups: HashMap<Vec<u8>, MlsGroup>,
}

impl Client {
    /// Creates a device with a fresh Ed25519 identity key. `identity` is the
    /// stable id other members see, e.g. `user_id/device_id`.
    pub fn new(identity: &[u8]) -> Result<Self, CryptoError> {
        let provider = OpenMlsRustCrypto::default();
        let signer =
            SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(mls_err)?;
        signer.store(provider.storage()).map_err(mls_err)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.to_public_vec().into(),
        };
        Ok(Self { provider, signer, credential, groups: HashMap::new() })
    }

    /// Public identity key, used for safety codes.
    pub fn identity_key(&self) -> &[u8] {
        self.signer.public()
    }

    /// Creates a single-use key package to upload to the server.
    pub fn key_package(&self) -> Result<Vec<u8>, CryptoError> {
        let bundle = KeyPackage::builder()
            .build(CIPHERSUITE, &self.provider, &self.signer, self.credential.clone())
            .map_err(mls_err)?;
        bundle.key_package().tls_serialize_detached().map_err(mls_err)
    }

    fn create_config() -> MlsGroupCreateConfig {
        MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .build()
    }

    fn group(&mut self, group_id: &[u8]) -> Result<&mut MlsGroup, CryptoError> {
        self.groups.get_mut(group_id).ok_or(CryptoError::UnknownGroup)
    }

    /// Starts a new group with this device as the only member. The id should
    /// be random and come from the server.
    pub fn create_group(&mut self, group_id: &[u8]) -> Result<(), CryptoError> {
        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &Self::create_config(),
            GroupId::from_slice(group_id),
            self.credential.clone(),
        )
        .map_err(mls_err)?;
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    /// Adds the owners of `key_packages` to the group. The commit stays
    /// pending until the server accepts it.
    pub fn add_members(
        &mut self,
        group_id: &[u8],
        key_packages: &[Vec<u8>],
    ) -> Result<CommitOut, CryptoError> {
        let mut kps = Vec::with_capacity(key_packages.len());
        for bytes in key_packages {
            let kp = KeyPackageIn::tls_deserialize_exact(bytes)
                .map_err(|_| CryptoError::Malformed)?
                .validate(self.provider.crypto(), ProtocolVersion::Mls10)
                .map_err(mls_err)?;
            kps.push(kp);
        }
        let provider = &self.provider;
        let signer = &self.signer;
        let group = self.groups.get_mut(group_id).ok_or(CryptoError::UnknownGroup)?;
        let (commit, welcome, _) =
            group.add_members(provider, signer, &kps).map_err(mls_err)?;
        Ok(CommitOut {
            commit: commit.to_bytes().map_err(mls_err)?,
            welcome: Some(welcome.to_bytes().map_err(mls_err)?),
        })
    }

    /// Removes every member whose credential identity is in `identities`.
    /// Merging the commit moves the group to a new epoch with fresh keys, so
    /// removed members can't read anything sent afterwards.
    pub fn remove_members(
        &mut self,
        group_id: &[u8],
        identities: &[Vec<u8>],
    ) -> Result<CommitOut, CryptoError> {
        let provider = &self.provider;
        let signer = &self.signer;
        let group = self.groups.get_mut(group_id).ok_or(CryptoError::UnknownGroup)?;
        let indices: Vec<LeafNodeIndex> = group
            .members()
            .filter(|m| identities.iter().any(|id| id == m.credential.serialized_content()))
            .map(|m| m.index)
            .collect();
        if indices.len() != identities.len() {
            return Err(CryptoError::NotAMember);
        }
        let (commit, welcome, _) =
            group.remove_members(provider, signer, &indices).map_err(mls_err)?;
        Ok(CommitOut {
            commit: commit.to_bytes().map_err(mls_err)?,
            welcome: welcome.map(|w| w.to_bytes()).transpose().map_err(mls_err)?,
        })
    }

    /// Rotates this device's own leaf keys.
    pub fn update_keys(&mut self, group_id: &[u8]) -> Result<CommitOut, CryptoError> {
        let provider = &self.provider;
        let signer = &self.signer;
        let group = self.groups.get_mut(group_id).ok_or(CryptoError::UnknownGroup)?;
        let bundle = group
            .self_update(provider, signer, Default::default())
            .map_err(mls_err)?;
        Ok(CommitOut { commit: bundle.commit().to_bytes().map_err(mls_err)?, welcome: None })
    }

    /// Applies this device's pending commit after the server accepted it.
    pub fn commit_accepted(&mut self, group_id: &[u8]) -> Result<(), CryptoError> {
        let provider = &self.provider;
        let group = self.groups.get_mut(group_id).ok_or(CryptoError::UnknownGroup)?;
        group.merge_pending_commit(provider).map_err(mls_err)
    }

    /// Drops this device's pending commit after the server rejected it
    /// (usually because another member's commit got in first).
    pub fn commit_rejected(&mut self, group_id: &[u8]) -> Result<(), CryptoError> {
        let provider = &self.provider;
        let group = self.groups.get_mut(group_id).ok_or(CryptoError::UnknownGroup)?;
        group.clear_pending_commit(provider.storage()).map_err(mls_err)
    }

    /// Joins a group from a welcome. Returns the group id.
    pub fn join(&mut self, welcome: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let MlsMessageBodyIn::Welcome(welcome) = MlsMessageIn::tls_deserialize_exact(welcome)
            .map_err(|_| CryptoError::Malformed)?
            .extract()
        else {
            return Err(CryptoError::Malformed);
        };
        let group = StagedWelcome::new_from_welcome(
            &self.provider,
            Self::create_config().join_config(),
            welcome,
            None,
        )
        .map_err(mls_err)?
        .into_group(&self.provider)
        .map_err(mls_err)?;
        let id = group.group_id().as_slice().to_vec();
        self.groups.insert(id.clone(), group);
        Ok(id)
    }

    /// Pads and encrypts an application message for the group.
    pub fn encrypt(&mut self, group_id: &[u8], content: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let padded = padding::pad(content)?;
        let provider = &self.provider;
        let signer = &self.signer;
        let group = self.groups.get_mut(group_id).ok_or(CryptoError::UnknownGroup)?;
        let msg = group.create_message(provider, signer, &padded).map_err(mls_err)?;
        msg.to_bytes().map_err(mls_err)
    }

    /// Processes a message the server delivered for the group.
    pub fn receive(&mut self, group_id: &[u8], bytes: &[u8]) -> Result<Incoming, CryptoError> {
        let msg = MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(|_| CryptoError::Malformed)?
            .try_into_protocol_message()
            .map_err(|_| CryptoError::Malformed)?;
        let provider = &self.provider;
        let group = self.groups.get_mut(group_id).ok_or(CryptoError::UnknownGroup)?;
        let processed = group.process_message(provider, msg).map_err(mls_err)?;
        let sender = processed.credential().serialized_content().to_vec();
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => {
                let content = padding::unpad(&app.into_bytes())?;
                Ok(Incoming::Message { sender, content })
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                let removed = staged.self_removed();
                group.merge_staged_commit(provider, *staged).map_err(mls_err)?;
                if removed {
                    self.groups.remove(group_id);
                    return Ok(Incoming::Removed);
                }
                Ok(Incoming::Commit { epoch: group.epoch().as_u64() })
            }
            // Standalone proposals aren't used: every change is a commit.
            _ => Err(CryptoError::Malformed),
        }
    }

    /// Current epoch of a group.
    pub fn epoch(&mut self, group_id: &[u8]) -> Result<u64, CryptoError> {
        Ok(self.group(group_id)?.epoch().as_u64())
    }

    /// Identities of the group's members, in leaf order.
    pub fn members(&mut self, group_id: &[u8]) -> Result<Vec<Vec<u8>>, CryptoError> {
        Ok(self
            .group(group_id)?
            .members()
            .map(|m| m.credential.serialized_content().to_vec())
            .collect())
    }

    /// Whether this device holds state for the group.
    pub fn in_group(&self, group_id: &[u8]) -> bool {
        self.groups.contains_key(group_id)
    }
}
