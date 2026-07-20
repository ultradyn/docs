export * from "./exact-map.js";
export * from "./lexical-index.js";
export * from "./stem-term.js";
export { createSourceTools } from "./source-tools.js";
export type {
  SourceTools,
  SourceToolError,
  SourceToolResult,
  SearchBackend,
  UnitStore,
} from "./source-tools.js";
export type {
  SearchBackendIdentity,
  UnitStoreRecord,
} from "./source-tool-seams.js";

// Receipt authenticity (T-30-04). Fakes stay in ./testing.js, never here.
export {
  attestSearchReceipt,
  verifyAttestedSearchReceipt,
  isAttestedSearchReceipt,
  receiptPayloadDigest,
  RECEIPT_ATTESTATION_LIMITS,
  type AttestedSearchReceipt,
  type SearchReceiptAttestation,
  type SearchReceiptAttestationAuthority,
  type ReceiptAttestationError,
} from "./receipt-attestation.js";
