//! End-to-end group flows between in-memory clients. Messages are passed
//! around as raw bytes, the way the delivery service would relay them.

use bastion_crypto::{safety_code, Client, Incoming};

const GROUP: &[u8] = b"0123456789abcdef";

fn msg(sender: &str, content: &str) -> Incoming {
    Incoming::Message {
        sender: sender.into(),
        content: content.into(),
    }
}

/// Alice creates a group and adds everyone else in one commit.
fn group_of(names: &[&str]) -> Vec<Client> {
    let mut clients: Vec<Client> = names
        .iter()
        .map(|n| Client::new(n.as_bytes()).unwrap())
        .collect();
    let kps: Vec<Vec<u8>> = clients[1..]
        .iter()
        .map(|c| c.key_package().unwrap())
        .collect();
    clients[0].create_group(GROUP).unwrap();
    let out = clients[0].add_members(GROUP, &kps).unwrap();
    clients[0].commit_accepted(GROUP).unwrap();
    let welcome = out.welcome.unwrap();
    for c in &mut clients[1..] {
        assert_eq!(c.join(&welcome).unwrap(), GROUP);
    }
    clients
}

#[test]
fn direct_message_round_trip() {
    let mut c = group_of(&["alice", "bob"]);
    let ct = c[0].encrypt(GROUP, b"hi bob").unwrap();
    assert!(!ct.windows(6).any(|w| w == b"hi bob"));
    assert_eq!(c[1].receive(GROUP, &ct).unwrap(), msg("alice", "hi bob"));

    let ct = c[1].encrypt(GROUP, b"hey alice").unwrap();
    assert_eq!(c[0].receive(GROUP, &ct).unwrap(), msg("bob", "hey alice"));
}

#[test]
fn ciphertext_sizes_hide_length() {
    let mut c = group_of(&["alice", "bob"]);
    let short = c[0].encrypt(GROUP, b"ok").unwrap();
    let longer = c[0].encrypt(GROUP, &[b'x'; 200]).unwrap();
    assert_eq!(short.len(), longer.len());
}

#[test]
fn both_sides_compute_the_same_safety_code() {
    let c = group_of(&["alice", "bob"]);
    let a = safety_code(b"alice", c[0].identity_key(), b"bob", c[1].identity_key());
    let b = safety_code(b"bob", c[1].identity_key(), b"alice", c[0].identity_key());
    assert_eq!(a, b);
}

#[test]
fn removal_rotates_keys() {
    let mut c = group_of(&["alice", "bob", "carol"]);
    let epoch = c[0].epoch(GROUP).unwrap();

    let out = c[0].remove_members(GROUP, &[b"carol".to_vec()]).unwrap();
    c[0].commit_accepted(GROUP).unwrap();
    assert_eq!(
        c[1].receive(GROUP, &out.commit).unwrap(),
        Incoming::Commit { epoch: epoch + 1 }
    );
    assert_eq!(
        c[0].members(GROUP).unwrap(),
        vec![b"alice".to_vec(), b"bob".to_vec()]
    );

    let ct = c[0].encrypt(GROUP, b"carol is gone").unwrap();
    assert_eq!(
        c[1].receive(GROUP, &ct).unwrap(),
        msg("alice", "carol is gone")
    );
    // Carol still holds the old epoch's keys, which don't open the new epoch.
    assert!(c[2].receive(GROUP, &ct).is_err());

    assert_eq!(c[2].receive(GROUP, &out.commit).unwrap(), Incoming::Removed);
    assert!(!c[2].in_group(GROUP));
}

#[test]
fn self_update_advances_epoch() {
    let mut c = group_of(&["alice", "bob"]);
    let out = c[1].update_keys(GROUP).unwrap();
    c[1].commit_accepted(GROUP).unwrap();
    assert!(matches!(
        c[0].receive(GROUP, &out.commit).unwrap(),
        Incoming::Commit { .. }
    ));
    let ct = c[0].encrypt(GROUP, b"still here").unwrap();
    assert_eq!(
        c[1].receive(GROUP, &ct).unwrap(),
        msg("alice", "still here")
    );
}

#[test]
fn rejected_commit_is_dropped() {
    let mut c = group_of(&["alice", "bob", "carol"]);
    // Bob and Carol both commit in the same epoch; the server keeps Bob's.
    let bob = c[1].update_keys(GROUP).unwrap();
    let _carol = c[2].update_keys(GROUP).unwrap();
    c[1].commit_accepted(GROUP).unwrap();
    c[2].commit_rejected(GROUP).unwrap();
    c[0].receive(GROUP, &bob.commit).unwrap();
    c[2].receive(GROUP, &bob.commit).unwrap();

    let ct = c[2].encrypt(GROUP, b"in sync").unwrap();
    assert_eq!(c[0].receive(GROUP, &ct).unwrap(), msg("carol", "in sync"));
    assert_eq!(c[1].receive(GROUP, &ct).unwrap(), msg("carol", "in sync"));
}

#[test]
fn late_joiner_cannot_read_earlier_messages() {
    let mut c = group_of(&["alice", "bob"]);
    let before = c[0].encrypt(GROUP, b"before dave").unwrap();
    c[1].receive(GROUP, &before).unwrap();

    let mut dave = Client::new(b"dave").unwrap();
    let out = c[0]
        .add_members(GROUP, &[dave.key_package().unwrap()])
        .unwrap();
    c[0].commit_accepted(GROUP).unwrap();
    c[1].receive(GROUP, &out.commit).unwrap();
    dave.join(&out.welcome.unwrap()).unwrap();

    assert!(dave.receive(GROUP, &before).is_err());
    let after = c[0].encrypt(GROUP, b"hi dave").unwrap();
    assert_eq!(
        dave.receive(GROUP, &after).unwrap(),
        msg("alice", "hi dave")
    );
}

#[test]
fn unknown_member_removal_fails() {
    let mut c = group_of(&["alice", "bob"]);
    assert!(c[0].remove_members(GROUP, &[b"mallory".to_vec()]).is_err());
}

#[test]
fn state_survives_save_and_load() {
    let mut c = group_of(&["alice", "bob"]);
    let ct = c[0].encrypt(GROUP, b"before reload").unwrap();
    assert_eq!(
        c[1].receive(GROUP, &ct).unwrap(),
        msg("alice", "before reload")
    );

    let saved = c[1].save_state().unwrap();
    let mut bob = Client::load_state(&saved).unwrap();
    assert!(bob.in_group(GROUP));
    assert_eq!(bob.identity_key(), c[1].identity_key());
    assert_eq!(bob.epoch(GROUP).unwrap(), c[0].epoch(GROUP).unwrap());

    // The reloaded device keeps talking to the live one, both ways.
    let ct = c[0].encrypt(GROUP, b"after reload").unwrap();
    assert_eq!(
        bob.receive(GROUP, &ct).unwrap(),
        msg("alice", "after reload")
    );
    let ct = bob.encrypt(GROUP, b"hi alice").unwrap();
    assert_eq!(c[0].receive(GROUP, &ct).unwrap(), msg("bob", "hi alice"));
}

#[test]
fn pending_commit_survives_reload() {
    let mut c = group_of(&["alice", "bob"]);
    let epoch = c[0].epoch(GROUP).unwrap();
    c[0].update_keys(GROUP).unwrap();
    let mut alice = Client::load_state(&c[0].save_state().unwrap()).unwrap();
    alice.commit_rejected(GROUP).unwrap();
    assert_eq!(alice.epoch(GROUP).unwrap(), epoch);
    let ct = alice.encrypt(GROUP, b"still fine").unwrap();
    assert_eq!(
        c[1].receive(GROUP, &ct).unwrap(),
        msg("alice", "still fine")
    );
}

#[test]
fn removed_group_stays_gone_after_reload() {
    let mut c = group_of(&["alice", "bob"]);
    let out = c[0].remove_members(GROUP, &[b"bob".to_vec()]).unwrap();
    c[0].commit_accepted(GROUP).unwrap();
    assert_eq!(c[1].receive(GROUP, &out.commit).unwrap(), Incoming::Removed);
    let bob = Client::load_state(&c[1].save_state().unwrap()).unwrap();
    assert!(!bob.in_group(GROUP));
}

#[test]
fn bad_state_is_rejected() {
    let c = Client::new(b"alice").unwrap();
    let mut saved = c.save_state().unwrap();
    assert!(Client::load_state(&saved[..saved.len() - 1]).is_err());
    saved[0] ^= 1;
    assert!(Client::load_state(&saved).is_err());
    assert!(Client::load_state(b"").is_err());
}
