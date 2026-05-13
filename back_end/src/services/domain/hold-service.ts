/**
 * SIG-S2/SIG-S3 HoldService — speculative holds (S2) + committed holds (S3).
 * S2 implementation: `s2-hold-service`; S3: `s3-hold-service`.
 */
export { placeSpeculativeHold, releaseSpeculativeHold } from "./s2-hold-service.js";
export { placeCommittedHold, releaseOnReEntry, confirmCommittedHoldTx, confirmCommittedHoldTx as confirmCommittedHold } from "./s3-hold-service.js";
