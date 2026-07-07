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

fn compute_commitment(
    token_in:    Field,
    token_out:   Field,
    size:        Field,
    min_out:     Field,
    expiry:      u64,
    price:       u64,
    direction:   bool,
    nonce:       Field,
    user_secret: Field,
) -> Field {
    let token_in_bytes  = field_to_address_bytes(token_in);
    let token_out_bytes = field_to_address_bytes(token_out);
    let size_bytes      = field_to_bytes_be(size);
    let min_out_bytes   = field_to_bytes_be(min_out);
    let expiry_bytes    = u64_to_bytes_be(expiry);
    let price_bytes     = u64_to_bytes_be(price);
    let nonce_bytes     = field_to_bytes_be(nonce);
    let secret_bytes    = field_to_bytes_be(user_secret);

    let mut preimage: [u8; 185] = [0; 185];

    for i in 0..20 { preimage[i] = token_in_bytes[i]; }
    for i in 0..20 { preimage[20 + i] = token_out_bytes[i]; }
    for i in 0..32 { preimage[40 + i] = size_bytes[i]; }
    for i in 0..32 { preimage[72 + i] = min_out_bytes[i]; }
    for i in 0..8  { preimage[104 + i] = expiry_bytes[i]; }
    for i in 0..8  { preimage[112 + i] = price_bytes[i]; }
    preimage[120] = direction as u8;
    for i in 0..32 { preimage[121 + i] = nonce_bytes[i]; }
    for i in 0..32 { preimage[153 + i] = secret_bytes[i]; }

    let hash_bytes = keccak256(preimage, 185);
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

fn assert_address_field(v: Field) {
    let bytes = v.to_be_bytes::<32>();
    for i in 0..12 {
        assert(bytes[i] == 0, "address field has non-zero high bytes");
    }
}

fn main(
    // Private witnesses
    price:        u64,
    direction:    bool,
    nonce:        Field,
    user_secret:  Field,
    // Public inputs:
    // [0] commitment_hash, [1] oracle_price, [2] nullifier,
    // [3] token_in, [4] token_out, [5] size, [6] min_out, [7] expiry.
    commitment_hash: pub Field,
    oracle_price:    pub u64,
    nullifier:       pub Field,
    token_in:        pub Field,
    token_out:       pub Field,
    size:            pub Field,
    min_out:         pub Field,
    expiry:          pub u64,
) {
    assert_address_field(token_in);
    assert_address_field(token_out);

    let computed_commitment = compute_commitment(
        token_in, token_out, size, min_out, expiry,
        price, direction, nonce, user_secret,
    );
    assert(computed_commitment == commitment_hash, "commitment mismatch");

    if !direction {
        assert(oracle_price <= price, "buy fill condition not met");
    } else {
        assert(oracle_price >= price, "sell fill condition not met");
    }

    let computed_nullifier = compute_nullifier(user_secret, nonce);
    assert(computed_nullifier == nullifier, "nullifier mismatch");
}

global WETH: Field = 0x0000000000000000000000004200000000000000000000000000000000000006;
global USDC: Field = 0x000000000000000000000000aabbccddeeff00112233445566778899aabbccdd;

#[test]
fn test_buy_fill_at_limit() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let expiry: u64      = 1_700_000_000;
    let price: u64       = 3000_00000000;
    let direction: bool  = false;
    let nonce: Field     = 0x1234;
    let user_secret: Field = 0xdeadbeef;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out, expiry, price, direction, nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        price, direction, nonce, user_secret,
        commitment, price, null, token_in, token_out, size, min_out, expiry,
    );
}

#[test]
fn test_buy_fill_below_limit() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let expiry: u64      = 1_700_000_000;
    let price: u64       = 3000_00000000;
    let direction: bool  = false;
    let nonce: Field     = 0xabcd;
    let user_secret: Field = 0xcafe;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out, expiry, price, direction, nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        price, direction, nonce, user_secret,
        commitment, price - 100, null, token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "buy fill condition not met")]
fn test_buy_fill_above_limit_fails() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let expiry: u64      = 1_700_000_000;
    let price: u64       = 3000_00000000;
    let direction: bool  = false;
    let nonce: Field     = 0x1111;
    let user_secret: Field = 0x2222;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out, expiry, price, direction, nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        price, direction, nonce, user_secret,
        commitment, price + 1, null, token_in, token_out, size, min_out, expiry,
    );
}

#[test]
fn test_sell_fill_at_limit() {
    let token_in: Field  = WETH;
    let token_out: Field = USDC;
    let size: Field      = 500_000_000_000_000_000;
    let min_out: Field   = 1_750_000000;
    let expiry: u64      = 1_700_000_000;
    let price: u64       = 3500_00000000;
    let direction: bool  = true;
    let nonce: Field     = 0x5678;
    let user_secret: Field = 0xfeedface;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out, expiry, price, direction, nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        price, direction, nonce, user_secret,
        commitment, price, null, token_in, token_out, size, min_out, expiry,
    );
}

#[test]
fn test_sell_fill_above_limit() {
    let token_in: Field  = WETH;
    let token_out: Field = USDC;
    let size: Field      = 500_000_000_000_000_000;
    let min_out: Field   = 1_750_000000;
    let expiry: u64      = 1_700_000_000;
    let price: u64       = 3500_00000000;
    let direction: bool  = true;
    let nonce: Field     = 0x9abc;
    let user_secret: Field = 0xbeef;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out, expiry, price, direction, nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        price, direction, nonce, user_secret,
        commitment, price + 200, null, token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "sell fill condition not met")]
fn test_sell_fill_below_limit_fails() {
    let token_in: Field  = WETH;
    let token_out: Field = USDC;
    let size: Field      = 500_000_000_000_000_000;
    let min_out: Field   = 1_750_000000;
    let expiry: u64      = 1_700_000_000;
    let price: u64       = 3500_00000000;
    let direction: bool  = true;
    let nonce: Field     = 0xdef0;
    let user_secret: Field = 0x1337;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out, expiry, price, direction, nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        price, direction, nonce, user_secret,
        commitment, price - 1, null, token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "commitment mismatch")]
fn test_tampered_commitment_fails() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let expiry: u64      = 1_700_000_000;
    let price: u64       = 3000_00000000;
    let direction: bool  = false;
    let nonce: Field     = 0xaaaa;
    let user_secret: Field = 0xbbbb;

    let null = compute_nullifier(user_secret, nonce);

    main(
        price, direction, nonce, user_secret,
        0xbadbeef, price - 1, null, token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "nullifier mismatch")]
fn test_tampered_nullifier_fails() {
    let token_in: Field  = USDC;
    let token_out: Field = WETH;
    let size: Field      = 3_000_000000;
    let min_out: Field   = 999_000_000_000_000;
    let expiry: u64      = 1_700_000_000;
    let price: u64       = 3000_00000000;
    let direction: bool  = false;
    let nonce: Field     = 0xcccc;
    let user_secret: Field = 0xdddd;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out, expiry, price, direction, nonce, user_secret,
    );

    main(
        price, direction, nonce, user_secret,
        commitment, price - 1, 0xbaad, token_in, token_out, size, min_out, expiry,
    );
}

#[test(should_fail_with = "address field has non-zero high bytes")]
fn test_malformed_address_field_fails() {
    let token_in: Field   = 0x0100000000000000000000000000000000000000000000000000000000000001;
    let token_out: Field  = USDC;
    let size: Field       = 3_000_000000;
    let min_out: Field    = 999_000_000_000_000;
    let expiry: u64       = 1_700_000_000;
    let price: u64        = 3000_00000000;
    let direction: bool   = false;
    let nonce: Field      = 0x1;
    let user_secret: Field = 0x2;

    let commitment = compute_commitment(
        token_in, token_out, size, min_out, expiry, price, direction, nonce, user_secret,
    );
    let null = compute_nullifier(user_secret, nonce);

    main(
        price, direction, nonce, user_secret,
        commitment, price, null, token_in, token_out, size, min_out, expiry,
    );
}
