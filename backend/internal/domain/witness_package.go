package domain

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
)

const WitnessEncryptionScheme = "SIMULATED_NITRO_X25519_AES_256_GCM"

func ValidateEncryptedWitnessPackage(pkg EncryptedWitnessPackage) error {
	if pkg.Version != 1 {
		return fmt.Errorf("unsupported witness package version")
	}
	if pkg.EncryptionScheme != WitnessEncryptionScheme {
		return fmt.Errorf("unsupported witness encryption scheme")
	}
	if pkg.CommitmentHash == "" || pkg.PackageHash == "" || pkg.Ciphertext == "" {
		return fmt.Errorf("witness package missing required fields")
	}
	if !strings.EqualFold(pkg.CommitmentHash, pkg.AAD.CommitmentHash) {
		return fmt.Errorf("witness package commitment mismatch")
	}
	if pkg.Kind != pkg.AAD.Kind {
		return fmt.Errorf("witness package kind mismatch")
	}

	actual, err := WitnessPackageHash(pkg)
	if err != nil {
		return err
	}
	if !strings.EqualFold(actual, pkg.PackageHash) {
		return fmt.Errorf("witness package hash mismatch")
	}
	return nil
}

func WitnessPackageHash(pkg EncryptedWitnessPackage) (string, error) {
	raw, err := json.Marshal(pkg)
	if err != nil {
		return "", fmt.Errorf("marshal witness package: %w", err)
	}
	var asMap map[string]any
	if err := json.Unmarshal(raw, &asMap); err != nil {
		return "", fmt.Errorf("decode witness package: %w", err)
	}
	delete(asMap, "packageHash")

	stable, err := json.Marshal(asMap)
	if err != nil {
		return "", fmt.Errorf("stable marshal witness package: %w", err)
	}
	sum := sha256.Sum256(stable)
	return fmt.Sprintf("0x%x", sum[:]), nil
}

func StableJSON(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return "", err
	}
	stable, err := json.Marshal(decoded)
	if err != nil {
		return "", err
	}
	return string(stable), nil
}
