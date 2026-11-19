//! JavaScript bindings, compiled only for wasm32.
//!
//! A thin wrapper over [`Client`]. Everything crosses the boundary as bytes
//! so the web app never touches MLS types.

use wasm_bindgen::prelude::*;

use crate::{Client, CryptoError, Incoming};

fn js_err(e: CryptoError) -> JsError {
    JsError::new(&e.to_string())
}

/// A commit and, when members were added, the welcome for them.
#[wasm_bindgen]
pub struct WasmCommit {
    commit: Vec<u8>,
    welcome: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl WasmCommit {
    #[wasm_bindgen(getter)]
    pub fn commit(&self) -> Vec<u8> {
        self.commit.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn welcome(&self) -> Option<Vec<u8>> {
        self.welcome.clone()
    }
}

/// What `receive` produced. `kind` is "message", "commit" or "removed".
#[wasm_bindgen]
pub struct WasmIncoming {
    kind: &'static str,
    sender: Vec<u8>,
    content: Vec<u8>,
    epoch: u64,
}

#[wasm_bindgen]
impl WasmIncoming {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.kind.to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn sender(&self) -> Vec<u8> {
        self.sender.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn content(&self) -> Vec<u8> {
        self.content.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

#[wasm_bindgen]
pub struct WasmClient {
    inner: Client,
}

#[wasm_bindgen]
impl WasmClient {
    #[wasm_bindgen(constructor)]
    pub fn new(identity: &[u8]) -> Result<WasmClient, JsError> {
        Ok(Self {
            inner: Client::new(identity).map_err(js_err)?,
        })
    }

    #[wasm_bindgen(js_name = keyPackage)]
    pub fn key_package(&self) -> Result<Vec<u8>, JsError> {
        self.inner.key_package().map_err(js_err)
    }

    #[wasm_bindgen(js_name = createGroup)]
    pub fn create_group(&mut self, group_id: &[u8]) -> Result<(), JsError> {
        self.inner.create_group(group_id).map_err(js_err)
    }

    #[wasm_bindgen(js_name = addMember)]
    pub fn add_member(
        &mut self,
        group_id: &[u8],
        key_package: &[u8],
    ) -> Result<WasmCommit, JsError> {
        let out = self
            .inner
            .add_members(group_id, &[key_package.to_vec()])
            .map_err(js_err)?;
        Ok(WasmCommit {
            commit: out.commit,
            welcome: out.welcome,
        })
    }

    /// Removes the members whose identities are listed (array of Uint8Array).
    #[wasm_bindgen(js_name = removeMembers)]
    pub fn remove_members(
        &mut self,
        group_id: &[u8],
        identities: Vec<js_sys::Uint8Array>,
    ) -> Result<WasmCommit, JsError> {
        let ids: Vec<Vec<u8>> = identities.iter().map(|i| i.to_vec()).collect();
        let out = self.inner.remove_members(group_id, &ids).map_err(js_err)?;
        Ok(WasmCommit {
            commit: out.commit,
            welcome: out.welcome,
        })
    }

    /// Rotates this device's keys in the group.
    #[wasm_bindgen(js_name = updateKeys)]
    pub fn update_keys(&mut self, group_id: &[u8]) -> Result<WasmCommit, JsError> {
        let out = self.inner.update_keys(group_id).map_err(js_err)?;
        Ok(WasmCommit {
            commit: out.commit,
            welcome: out.welcome,
        })
    }

    /// Drops a pending commit the server rejected.
    #[wasm_bindgen(js_name = commitRejected)]
    pub fn commit_rejected(&mut self, group_id: &[u8]) -> Result<(), JsError> {
        self.inner.commit_rejected(group_id).map_err(js_err)
    }

    /// Identities of the group's members, as an array of Uint8Array.
    pub fn members(&mut self, group_id: &[u8]) -> Result<Vec<js_sys::Uint8Array>, JsError> {
        Ok(self
            .inner
            .members(group_id)
            .map_err(js_err)?
            .iter()
            .map(|m| js_sys::Uint8Array::from(m.as_slice()))
            .collect())
    }

    #[wasm_bindgen(js_name = inGroup)]
    pub fn in_group(&self, group_id: &[u8]) -> bool {
        self.inner.in_group(group_id)
    }

    /// Serializes all device state. SECRET: encrypt before storing.
    #[wasm_bindgen(js_name = saveState)]
    pub fn save_state(&self) -> Result<Vec<u8>, JsError> {
        self.inner.save_state().map_err(js_err)
    }

    /// Restores a device from `saveState` output.
    #[wasm_bindgen(js_name = loadState)]
    pub fn load_state(bytes: &[u8]) -> Result<WasmClient, JsError> {
        Ok(Self {
            inner: Client::load_state(bytes).map_err(js_err)?,
        })
    }

    #[wasm_bindgen(js_name = commitAccepted)]
    pub fn commit_accepted(&mut self, group_id: &[u8]) -> Result<(), JsError> {
        self.inner.commit_accepted(group_id).map_err(js_err)
    }

    pub fn join(&mut self, welcome: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.join(welcome).map_err(js_err)
    }

    pub fn encrypt(&mut self, group_id: &[u8], content: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.encrypt(group_id, content).map_err(js_err)
    }

    pub fn receive(&mut self, group_id: &[u8], bytes: &[u8]) -> Result<WasmIncoming, JsError> {
        Ok(match self.inner.receive(group_id, bytes).map_err(js_err)? {
            Incoming::Message { sender, content } => WasmIncoming {
                kind: "message",
                sender,
                content,
                epoch: 0,
            },
            Incoming::Commit { epoch } => WasmIncoming {
                kind: "commit",
                sender: Vec::new(),
                content: Vec::new(),
                epoch,
            },
            Incoming::Removed => WasmIncoming {
                kind: "removed",
                sender: Vec::new(),
                content: Vec::new(),
                epoch: 0,
            },
        })
    }
}

#[wasm_bindgen]
impl WasmClient {
    /// Public identity key, for safety codes.
    #[wasm_bindgen(js_name = identityKey)]
    pub fn identity_key(&self) -> Vec<u8> {
        self.inner.identity_key().to_vec()
    }

    pub fn epoch(&mut self, group_id: &[u8]) -> Result<f64, JsError> {
        self.inner.epoch(group_id).map(|e| e as f64).map_err(js_err)
    }
}

/// The shared 60-digit safety code for two people.
#[wasm_bindgen(js_name = safetyCode)]
pub fn safety_code(a_user: &[u8], a_key: &[u8], b_user: &[u8], b_key: &[u8]) -> String {
    crate::safety_code(a_user, a_key, b_user, b_key)
}
