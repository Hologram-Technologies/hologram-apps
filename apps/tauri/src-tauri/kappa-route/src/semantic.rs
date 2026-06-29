// semantic.rs — W3C Linked Data conformance in the shipping crate (validate-before-serve).
//
// Before the host serves a κ-object as semantic data, it checks the object is valid, interoperable Linked
// Data — every property a term in the authoritative W3C vocabularies (ActivityStreams 2.0 + schema.org +
// DID-core) or a declared local-context extension. A κ-object with non-standard vocabulary is flagged, so a
// human's browser and an AI agent (and any third-party W3C consumer) understand it identically. Rust twin of
// holo-standards.mjs; the authoritative contexts are vendored (src/contexts) and interned once.

use std::collections::HashSet;
use std::ffi::{c_char, CStr};
use std::sync::OnceLock;

const AS2_CONTEXT: &str = include_str!("contexts/activitystreams-context.json");
const SCHEMA_CONTEXT: &str = include_str!("contexts/schema-org-context.json");

/// JSON-LD keywords + DID-core v1 terms + the Hologram κ-object envelope, always allowed.
const STRUCTURAL: &[&str] = &[
    "id", "type", "controller", "verificationMethod", "authentication", "assertionMethod",
    "keyAgreement", "capabilityInvocation", "capabilityDelegation", "service", "serviceEndpoint",
    "publicKeyMultibase", "publicKeyJwk", "kappa", "did", "proof",
];

/// The interned set of authoritative terms (AS2 + schema.org + structural). Built once.
fn known_terms() -> &'static HashSet<String> {
    static TERMS: OnceLock<HashSet<String>> = OnceLock::new();
    TERMS.get_or_init(|| {
        let mut set = HashSet::new();
        for src in [AS2_CONTEXT, SCHEMA_CONTEXT] {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(src) {
                if let Some(ctx) = v.get("@context").and_then(|c| c.as_object()) {
                    for k in ctx.keys() {
                        set.insert(k.clone());
                    }
                }
            }
        }
        for k in STRUCTURAL {
            set.insert((*k).to_string());
        }
        set
    })
}

fn validate_json(s: &str) -> bool {
    let v: serde_json::Value = match serde_json::from_str(s) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let obj = match v.as_object() {
        Some(o) => o,
        None => return false,
    };
    let known = known_terms();
    // The object's own inline @context legitimately extends the known vocabulary.
    let mut local = HashSet::new();
    if let Some(ctx) = obj.get("@context") {
        let entries: Vec<&serde_json::Value> = ctx.as_array().map(|a| a.iter().collect()).unwrap_or_else(|| vec![ctx]);
        for e in entries {
            if let Some(o) = e.as_object() {
                for k in o.keys() {
                    local.insert(k.clone());
                }
            }
        }
    }
    for key in obj.keys() {
        if key.starts_with('@') || known.contains(key) || local.contains(key) {
            continue;
        }
        // CURIE / IRI keys are valid Linked Data: a full IRI ("https://ex/term"), or "prefix:term" where the
        // prefix is declared in the doc's @context (e.g. "dcat:dataset" with "dcat" mapped) — JSON-LD expansion.
        if key.contains("://") {
            continue;
        }
        if let Some(colon) = key.find(':') {
            let prefix = &key[..colon];
            if local.contains(prefix) || known.contains(prefix) {
                continue;
            }
        }
        return false;
    }
    true
}

/// Validate one JSON-LD object (NUL-terminated JSON). Returns 1 if every property is a W3C AS2 / schema.org /
/// DID-core term, a JSON-LD keyword, or a declared local-context term; else 0. The host's validate-before-serve.
/// # Safety: `json` a NUL-terminated C string (or NULL).
#[no_mangle]
pub unsafe extern "C" fn kr_ld_validate(json: *const c_char) -> u8 {
    if json.is_null() {
        return 0;
    }
    match CStr::from_ptr(json).to_str() {
        Ok(s) => validate_json(s) as u8,
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_w3c_ld_rejects_nonstandard() {
        assert!(known_terms().len() > 1000, "authoritative AS2+schema.org terms interned");
        // valid schema.org Product
        assert!(validate_json(r#"{"@context":"https://schema.org","@type":"Product","name":"Lamp","brand":"Lumen","offers":{"@type":"Offer","price":"199"}}"#));
        // valid AS2 Note
        assert!(validate_json(r#"{"@context":"https://www.w3.org/ns/activitystreams","type":"Note","content":"hi","published":"2026-06-24T00:00:00Z"}"#));
        // valid DID Document (DID-core terms)
        assert!(validate_json(r#"{"@context":["https://www.w3.org/ns/did/v1"],"id":"did:holo:ab","verificationMethod":[],"authentication":[],"service":[]}"#));
        // non-standard property → rejected
        assert!(!validate_json(r#"{"@context":"https://schema.org","@type":"Product","wibbleProperty":"x"}"#));
        // a local @context extension is allowed
        assert!(validate_json(r#"{"@context":{"customTerm":"https://ex/c"},"customTerm":"ok"}"#));
        // CURIE: "prefix:term" is valid when the prefix is declared in @context (real-world prefixed JSON-LD)
        assert!(validate_json(r#"{"@context":{"dcat":"http://www.w3.org/ns/dcat#"},"@id":"x","dcat:dataset":[]}"#));
        // a CURIE whose prefix is NOT declared → still rejected
        assert!(!validate_json(r#"{"@context":{},"bogus:term":1}"#));
        // a full-IRI key is valid Linked Data
        assert!(validate_json(r#"{"@context":{},"https://schema.org/name":"Lamp"}"#));
        // not JSON → invalid
        assert!(!validate_json("not json"));
    }
}
