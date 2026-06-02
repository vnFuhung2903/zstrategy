export * from "./attestation";
export * from "./noirProofGenerator";
export * from "./simulatedNitroEnclave";
export * from "./types";
export {
  WITNESS_ECIES_CONFIG,
  WITNESS_ENCRYPTION_SCHEME,
  assertValidPackageHash,
  createEncryptedWitnessPackage,
  packageHash,
  type WitnessAttestationExpectations,
} from "./witnessPackage";
