// did.rs — did:holo, a κ-rooted W3C Decentralized Identifier, in the shipping crate (host peer identity).
//
// The native browser presents a W3C DID as its peer/agent identity on the content network. did:holo:<κ> is
// SELF-CERTIFYING: the identifier IS the sha256 of the controller's public key, so a resolver re-derives
// sha256(key) and refuses a mismatch (Law L5) — no registry, no CA. The host serves its DID Document at the
// standard `/.well-known/did.json`, so any W3C consumer or agent resolves + verifies it. Lean: sha256 only
// (no signing dep in the shipping crate; VC signing lives in the sidecar / JS identity layer).

use std::ffi::{c_char, CStr};

use crate::sha256_hex;

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// base58btc (Bitcoin alphabet) — for the canonical W3C Ed25519VerificationKey2020 multibase. Dependency-free.
fn base58btc(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let zeros = data.iter().take_while(|&&b| b == 0).count();
    let mut digits: Vec<u8> = Vec::new();
    for &byte in data {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len() + 1);
    for _ in 0..zeros {
        out.push('1');
    }
    for &d in digits.iter().rev() {
        out.push(ALPHABET[d as usize] as char);
    }
    if out.is_empty() {
        out.push('1');
    }
    out
}

/// The verification-key multibase for the DID Document. A raw 32-byte Ed25519 key (the holo identity layer
/// exports `pub` as raw — `exportKey("raw")`) → the canonical W3C Ed25519VerificationKey2020 form:
/// `z` + base58btc(multicodec ed25519-pub `0xed 0x01` ‖ key) — the same `z6Mk…` shape did:key uses, so any
/// W3C DID resolver / agent recognizes it. Defensive: a 44-byte SPKI is stripped to its trailing 32 bytes;
/// any other length falls back to multibase base16 (`f` + hex) rather than mislabel a non-Ed25519 key.
fn verification_multibase(bytes: &[u8]) -> String {
    const SPKI_PREFIX: &[u8] = &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
    let raw: &[u8] = if bytes.len() == 44 && bytes.starts_with(SPKI_PREFIX) {
        &bytes[12..]
    } else {
        bytes
    };
    if raw.len() == 32 {
        let mut mc = Vec::with_capacity(34);
        mc.push(0xed);
        mc.push(0x01);
        mc.extend_from_slice(raw);
        format!("z{}", base58btc(&mc))
    } else {
        format!("f{}", hex(raw)) // not a raw Ed25519 key → honest base16, never a mislabeled z-key
    }
}

/// did:holo:<sha256(pubkey)> for the given controller public key bytes. Heap C string; free with
/// kr_cache_free_mime. NULL on bad input.
/// # Safety: `pubkey` points to `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn kr_did_from_key(pubkey: *const u8, len: usize) -> *mut c_char {
    if pubkey.is_null() || len == 0 {
        return std::ptr::null_mut();
    }
    let bytes = std::slice::from_raw_parts(pubkey, len);
    let did = format!("did:holo:{}", sha256_hex(bytes));
    std::ffi::CString::new(did).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// 1 iff `did` == did:holo:sha256(pubkey) — self-certifying verification (no registry). Else 0.
/// # Safety: `did` a NUL-terminated C string; `pubkey` points to `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn kr_did_verify(did: *const c_char, pubkey: *const u8, len: usize) -> u8 {
    if did.is_null() || pubkey.is_null() {
        return 0;
    }
    let d = match CStr::from_ptr(did).to_str() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let bytes = std::slice::from_raw_parts(pubkey, len);
    (d == format!("did:holo:{}", sha256_hex(bytes))) as u8
}

/// The W3C DID Document (JSON) for did:holo rooted in `pubkey`, advertising the Ed25519 verification key and a
/// HoloContentNetwork service endpoint. Heap C string; free with kr_cache_free_mime. NULL on bad input.
/// # Safety: `pubkey` points to `len` bytes; `endpoint` a NUL-terminated C string (or NULL).
#[no_mangle]
pub unsafe extern "C" fn kr_did_document(pubkey: *const u8, len: usize, endpoint: *const c_char) -> *mut c_char {
    if pubkey.is_null() || len == 0 {
        return std::ptr::null_mut();
    }
    let bytes = std::slice::from_raw_parts(pubkey, len);
    let did = format!("did:holo:{}", sha256_hex(bytes));
    let mb = verification_multibase(bytes); // canonical Ed25519VerificationKey2020 multibase
    let ep = if endpoint.is_null() {
        "holo-mesh://auto".to_string()
    } else {
        CStr::from_ptr(endpoint).to_str().unwrap_or("holo-mesh://auto").to_string()
    };
    let doc = serde_json::json!({
        "@context": ["https://www.w3.org/ns/did/v1"],
        "id": did,
        "verificationMethod": [{
            "id": format!("{did}#key-1"),
            "type": "Ed25519VerificationKey2020",
            "controller": did,
            "publicKeyMultibase": mb,
        }],
        "authentication": [format!("{did}#key-1")],
        "assertionMethod": [format!("{did}#key-1")],
        "service": [{
            "id": format!("{did}#mesh"),
            "type": "HoloContentNetwork",
            "serviceEndpoint": ep,
        }],
    });
    std::ffi::CString::new(doc.to_string()).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// The W3C DID Document (JSON) for an EXPLICIT did (e.g. the TEE-authenticated operator κ, which is already a
/// valid `did:holo:sha256:<hex>`), with `pubkey` as the verification key. This is the unified-identity form:
/// the host's peer/mesh/agent DID IS the operator identity — not a separately-computed key. Heap C string; free
/// with kr_cache_free_mime. NULL on bad input.
/// # Safety: `did`/`endpoint` NUL-terminated C strings (endpoint may be NULL); `pubkey` points to `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn kr_did_document_for(
    did: *const c_char,
    pubkey: *const u8,
    len: usize,
    endpoint: *const c_char,
) -> *mut c_char {
    if did.is_null() || pubkey.is_null() || len == 0 {
        return std::ptr::null_mut();
    }
    let did_s = match CStr::from_ptr(did).to_str() {
        Ok(s) if !s.is_empty() => s.to_string(),
        _ => return std::ptr::null_mut(),
    };
    let bytes = std::slice::from_raw_parts(pubkey, len);
    let mb = verification_multibase(bytes);
    let ep = if endpoint.is_null() {
        "holo-mesh://auto".to_string()
    } else {
        CStr::from_ptr(endpoint).to_str().unwrap_or("holo-mesh://auto").to_string()
    };
    let doc = serde_json::json!({
        "@context": ["https://www.w3.org/ns/did/v1"],
        "id": did_s,
        "verificationMethod": [{
            "id": format!("{did_s}#key-1"),
            "type": "Ed25519VerificationKey2020",
            "controller": did_s,
            "publicKeyMultibase": mb,
        }],
        "authentication": [format!("{did_s}#key-1")],
        "assertionMethod": [format!("{did_s}#key-1")],
        "service": [{
            "id": format!("{did_s}#mesh"),
            "type": "HoloContentNetwork",
            "serviceEndpoint": ep,
        }],
    });
    std::ffi::CString::new(doc.to_string()).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn did_holo_is_kappa_rooted_and_self_certifying() {
        let key = b"ed25519-public-key-bytes-of-peer";
        unsafe {
            let did_ptr = kr_did_from_key(key.as_ptr(), key.len());
            let did = CStr::from_ptr(did_ptr).to_str().unwrap().to_string();
            assert!(did.starts_with("did:holo:") && did.len() == 9 + 64, "did:holo:<64hex>: {did}");
            assert_eq!(&did[9..], &sha256_hex(key), "the DID is sha256 of the key");

            let cdid = CString::new(did.clone()).unwrap();
            assert_eq!(kr_did_verify(cdid.as_ptr(), key.as_ptr(), key.len()), 1, "right key verifies");
            let wrong = b"a totally different public key!!";
            assert_eq!(kr_did_verify(cdid.as_ptr(), wrong.as_ptr(), wrong.len()), 0, "wrong key refused");

            let doc_ptr = kr_did_document(key.as_ptr(), key.len(), std::ptr::null());
            let doc = CStr::from_ptr(doc_ptr).to_str().unwrap();
            let v: serde_json::Value = serde_json::from_str(doc).unwrap();
            assert_eq!(v["id"], did, "DID Document id == the did:holo");
            // a raw 32-byte Ed25519 key → canonical W3C multibase (z + base58btc(0xed01‖key)) = the z6Mk… shape.
            let mb = v["verificationMethod"][0]["publicKeyMultibase"].as_str().unwrap();
            assert!(mb.starts_with("z6Mk"), "canonical Ed25519VerificationKey2020 multibase: {mb}");
            // a non-32-byte key is NOT mislabeled as a z-key — honest base16 fallback.
            let short = b"not-32-bytes";
            let sp = kr_did_document(short.as_ptr(), short.len(), std::ptr::null());
            let sv: serde_json::Value = serde_json::from_str(CStr::from_ptr(sp).to_str().unwrap()).unwrap();
            assert!(sv["verificationMethod"][0]["publicKeyMultibase"].as_str().unwrap().starts_with('f'),
                "non-Ed25519 length → base16, never a fake z-key");
            crate::ffi::kr_cache_free_mime(sp);

            // Unified-identity form: the DID Document carries an EXPLICIT operator κ as its id.
            let op = CString::new("did:holo:sha256:abcdef").unwrap();
            let for_ptr = kr_did_document_for(op.as_ptr(), key.as_ptr(), key.len(), std::ptr::null());
            let fv: serde_json::Value = serde_json::from_str(CStr::from_ptr(for_ptr).to_str().unwrap()).unwrap();
            assert_eq!(fv["id"], "did:holo:sha256:abcdef", "DID Document id == the explicit operator κ");
            assert_eq!(fv["verificationMethod"][0]["controller"], "did:holo:sha256:abcdef");

            crate::ffi::kr_cache_free_mime(did_ptr);
            crate::ffi::kr_cache_free_mime(doc_ptr);
            crate::ffi::kr_cache_free_mime(for_ptr);
        }
    }
}
