// DCA (Dollar-Cost Averaging) circuit
//
// Proves that:
//   1. The commitment_hash binds to the on-chain registration fields
//      (token_in, token_out, size, min_out, expiry) AND the private
//      schedule params (scheduled_lo, scheduled_hi, nonce, user_secret).
//   2. The time fill condition is satisfied: the current block timestamp
//      falls within the private execution window [scheduled_lo, scheduled_hi].
//   3. The commitment has not expired: block_timestamp < expiry.
//   4. The nullifier is correctly derived from (user_secret, nonce).
//
// Preimage layout (192 bytes, packed big-endian):
//
//   token_in(20) || token_out(20) || size(32) || min_out(32) ||
//   scheduled_lo(8) || scheduled_hi(8) || expiry(8) ||
//   nonce(32) || user_secret(32)
//
// Privacy model:
//   scheduled_lo and scheduled_hi are private, an observer sees only that
//   a DCA round executed, not when it was scheduled or what the interval is.

use keccak256::keccak256;

fn u64_to_bytes_be(v: u64) -> [u8; 8] {
    [
        ((v >> 56) & 0xff) as u8,
        ((v >> 48) & 0xff) as u8,
        ((v >> 40) & 0xff) as u8,
        ((v >> 32) & 0xff) as u8,
        ((v >> 24) & 0xff) as u8,
        ((v >> 16) & 0xff) as u8,
        ((v >>  8) & 0xff) as u8,
        ( v        & 0xff) as u8,
    ]
}

fn field_to_bytes_be(v: Field) -> [u8; 32] {
    v.to_be_bytes::<32>()
}

fn field_to_address_bytes(v: Field) -> [u8; 20] {
    let bytes = v.to_be_bytes::<32>();
    let mut out: [u8; 20] = [0; 20];
    for i in 0..20 {
        out[i] = bytes[12 + i];
    }
    out
}

fn assert_address_field(v: Field) {
    let bytes = v.to_be_bytes::<32>();
    for i in 0..12 {
        assert(bytes[i] == 0, "address field has non-zero high bytes");
    }
}

fn compute_commitment(
    token_in:     Field,
    token_out:    Field,
    size:         Field,
    min_out:      Field,
    scheduled_lo: u64,
    scheduled_hi: u64,
    expiry:       u64,
    nonce:        Field,
    user_secret:  Field,
) -> Field {
    let token_in_bytes     = field_to_address_bytes(token_in);
    let token_out_bytes    = field_to_address_bytes(token_out);
    let size_bytes         = field_to_bytes_be(size);
    let min_out_bytes      = field_to_bytes_be(min_out);
    let scheduled_lo_bytes = u64_to_bytes_be(scheduled_lo);
    let scheduled_hi_bytes = u64_to_bytes_be(scheduled_hi);
    let expiry_bytes       = u64_to_bytes_be(expiry);
    let nonce_bytes        = field_to_bytes_be(nonce);
    let secret_bytes       = field_to_bytes_be(user_secret);

    let mut preimage: [u8; 192] = [0; 192];

    // token_in (bytes 0..20)
    for i in 0..20 { preimage[i] = token_in_bytes[i]; }
    // token_out (bytes 20..40)
    for i in 0..20 { preimage[20 + i] = token_out_bytes[i]; }
    // size (bytes 40..72)
    for i in 0..32 { preimage[40 + i] = size_bytes[i]; }
    // min_out (bytes 72..104)
    for i in 0..32 { preimage[72 + i] = min_out_bytes[i]; }
    // scheduled_lo (bytes 104..112)
    for i in 0..8  { preimage[104 + i] = scheduled_lo_bytes[i]; }
    // scheduled_hi (bytes 112..120)
    for i in 0..8  { preimage[112 + i] = scheduled_hi_bytes[i]; }
    // expiry (bytes 120..128)
    for i in 0..8  { preimage[120 + i] = expiry_bytes[i]; }
    // nonce (bytes 128..160)
    for i in 0..32 { preimage[128 + i] = nonce_bytes[i]; }
    // user_secret (bytes 160..192)
    for i in 0..32 { preimage[160 + i] = secret_bytes[i]; }

    let hash_bytes = keccak256(preimage, 192);
    Field::from_be_bytes::<32>(hash_bytes)
}

fn compute_nullifier(user_secret: Field, nonce: Field) -> Field {
    let secret_bytes = field_to_bytes_be(user_secret);
    let nonce_bytes  = field_to_bytes_be(nonce);

    let mut preimage: [u8; 64] = [0; 64];
    for i in 0..32 { preimage[i]      = secret_bytes[i]; }
    for i in 0..32 { preimage[32 + i] = nonce_bytes[i];  }

    let hash_bytes = keccak256(preimage, 64);
    Field::from_be_bytes::<32>(hash_bytes)
}

fn main(
    // Private witnesses
    scheduled_lo: u64,
    scheduled_hi: u64,
    nonce:        Field,
    user_secret:  Field,
    // Public inputs:
    // [0] commitment_hash, [1] block_timestamp, [2] nullifier,
    // [3] token_in, [4] token_out, [5] size, [6] min_out, [7] expiry.
    commitment_hash: pub Field,
    block_timestamp: pub u64,
    nullifier:       pub Field,
    token_in:        pub Field,
    token_out:       pub Field,
    size:            pub Field,
    min_out:         pub Field,
    expiry:          pub u64,
) {
    assert_address_field(token_in);
    assert_address_field(token_out);

    // 1. Commitment preimage check
    let computed_commitment = compute_commitment(
        token_in, token_out, size, min_out,
        scheduled_lo, scheduled_hi, expiry,
        nonce, user_secret,
    );
    assert(computed_commitment == commitment_hash, "commitment mismatch");

    // 2. Time fill condition: block_timestamp falls within the private window
    assert(block_timestamp >= scheduled_lo, "too early: before scheduled window");
    assert(block_timestamp <= scheduled_hi, "too late: after scheduled window");

    // 3. Not expired
    assert(block_timestamp < expiry, "commitment expired");

    // 4. Nullifier derivation
    let computed_nullifier = compute_nullifier(user_secret, nonce);
    assert(computed_nullifier == nullifier, "nullifier mismatch");
}

global WETH: Field = 0x0000000000000000000000004200000000000000000000000000000000000006;
global USDC: Field = 0x000000000000000000000000aabbccddeeff00112233445566778899aabbccdd;

#[test]
fn test_fill_at_window_start() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;        // 3000 USDC
    let min_out: Field   = 999_000_000_000_000; // ~0.999 WETH
    let scheduled_lo: u64 = 1_700_000_000;
    let scheduled_hi: u64 = 1_700_000_000 + 3600; // 1-hour window
    let expiry: u64       = 1_700_000_000 + 86400;
    let nonce: Field      = 0x1234;
    let user_secret: Field = 0xdeadbeef;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out,
        scheduled_lo, scheduled_hi, expiry,
        nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    // Execute exactly at window open
    main(
        scheduled_lo, scheduled_hi, nonce, user_secret,
        commitment, scheduled_lo, null,
        token_in, token_out, size, min_out, expiry,
    );
}

#[test]
fn test_fill_mid_window() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let scheduled_lo: u64 = 1_700_000_000;
    let scheduled_hi: u64 = 1_700_000_000 + 3600;
    let expiry: u64       = 1_700_000_000 + 86400;
    let nonce: Field      = 0xabcd;
    let user_secret: Field = 0xcafe;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out,
        scheduled_lo, scheduled_hi, expiry,
        nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    // Execute in the middle of the window
    main(
        scheduled_lo, scheduled_hi, nonce, user_secret,
        commitment, scheduled_lo + 1800, null,
        token_in, token_out, size, min_out, expiry,
    );
}

#[test]
fn test_fill_at_window_end() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let scheduled_lo: u64 = 1_700_000_000;
    let scheduled_hi: u64 = 1_700_000_000 + 3600;
    let expiry: u64       = 1_700_000_000 + 86400;
    let nonce: Field      = 0x5678;
    let user_secret: Field = 0xfeedface;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out,
        scheduled_lo, scheduled_hi, expiry,
        nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    // Execute exactly at window close
    main(
        scheduled_lo, scheduled_hi, nonce, user_secret,
        commitment, scheduled_hi, null,
        token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "too early: before scheduled window")]
fn test_fill_before_window_fails() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let scheduled_lo: u64 = 1_700_000_000;
    let scheduled_hi: u64 = 1_700_000_000 + 3600;
    let expiry: u64       = 1_700_000_000 + 86400;
    let nonce: Field      = 0x1111;
    let user_secret: Field = 0x2222;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out,
        scheduled_lo, scheduled_hi, expiry,
        nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        scheduled_lo, scheduled_hi, nonce, user_secret,
        commitment, scheduled_lo - 1, null,
        token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "too late: after scheduled window")]
fn test_fill_after_window_fails() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let scheduled_lo: u64 = 1_700_000_000;
    let scheduled_hi: u64 = 1_700_000_000 + 3600;
    let expiry: u64       = 1_700_000_000 + 86400;
    let nonce: Field      = 0x3333;
    let user_secret: Field = 0x4444;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out,
        scheduled_lo, scheduled_hi, expiry,
        nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        scheduled_lo, scheduled_hi, nonce, user_secret,
        commitment, scheduled_hi + 1, null,
        token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "commitment expired")]
fn test_fill_after_expiry_fails() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let scheduled_lo: u64 = 1_700_090_000;
    let scheduled_hi: u64 = 1_700_090_000 + 3600;
    let expiry: u64       = 1_700_090_000 - 1;
    let nonce: Field      = 0x5555;
    let user_secret: Field = 0x6666;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out,
        scheduled_lo, scheduled_hi, expiry,
        nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    // block_timestamp is within the window but past expiry
    main(
        scheduled_lo, scheduled_hi, nonce, user_secret,
        commitment, scheduled_lo, null,
        token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "commitment mismatch")]
fn test_tampered_commitment_fails() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let scheduled_lo: u64 = 1_700_000_000;
    let scheduled_hi: u64 = 1_700_000_000 + 3600;
    let expiry: u64       = 1_700_000_000 + 86400;
    let nonce: Field      = 0x7777;
    let user_secret: Field = 0x8888;

    let null = compute_nullifier(user_secret, nonce);

    main(
        scheduled_lo, scheduled_hi, nonce, user_secret,
        0xbadbeef, scheduled_lo + 100, null,
        token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "nullifier mismatch")]
fn test_tampered_nullifier_fails() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let scheduled_lo: u64 = 1_700_000_000;
    let scheduled_hi: u64 = 1_700_000_000 + 3600;
    let expiry: u64       = 1_700_000_000 + 86400;
    let nonce: Field      = 0x9999;
    let user_secret: Field = 0xaaaa;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out,
        scheduled_lo, scheduled_hi, expiry,
        nonce, user_secret,
    );

    main(
        scheduled_lo, scheduled_hi, nonce, user_secret,
        commitment, scheduled_lo + 100, 0xbaad,
        token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "address field has non-zero high bytes")]
fn test_malformed_address_field_fails() {
    let token_in: Field   = 0x0100000000000000000000000000000000000000000000000000000000000001;
    let token_out: Field  = USDC;
    let size: Field       = 3_000_000000;
    let min_out: Field    = 999_000_000_000_000;
    let scheduled_lo: u64 = 1_700_000_000;
    let scheduled_hi: u64 = 1_700_000_000 + 3600;
    let expiry: u64       = 1_700_000_000 + 86400;
    let nonce: Field      = 0x1;
    let user_secret: Field = 0x2;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out,
        scheduled_lo, scheduled_hi, expiry,
        nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        scheduled_lo, scheduled_hi, nonce, user_secret,
        commitment, scheduled_lo, null,
        token_in, token_out, size, min_out, expiry,
    );
}
