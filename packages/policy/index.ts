// Public entry point for @tessera/policy
// Deep module exposing autonomous spending policy evaluation and HITL risk engine

// Core policy evaluation engine
export {
  evaluatePolicy,
  extractMerchantDomain,
  isDomainAllowed,
  PolicyEngine,
  type PolicyEngineOptions,
  validateMerchantDomain,
} from "./lib/engine/policyEngine.js";
// Human-in-the-Loop (HITL) escalation queue and cryptographic counter-signatures
export {
  createSupervisorApprovalPayload,
  DEFAULT_HITL_TTL_MS,
  type EnqueueOptions,
  HITLQueue,
  type HITLQueueOptions,
  signSupervisorApproval,
  submitSupervisorApproval,
} from "./lib/hitl/hitlQueue.js";

// Composite risk scoring model (0-100)
export {
  type RiskEvaluation,
  RiskScorer,
  type RiskScorerInputs,
  scoreRisk,
} from "./lib/risk/riskScorer.js";
// Domain errors and violation codes
export {
  DisallowedCategoryError,
  HITLDecisionStatus,
  type HITLQueueItem,
  HITLQueueStatus,
  InvalidQueueStateError,
  InvalidSupervisorSignatureError,
  MerchantDisallowedError,
  MerchantSpoofingError,
  type PolicyConfig,
  type PolicyEvaluationResult,
  PolicyRuleViolationCode,
  PolicyRuleViolationError,
  type PolicyViolationDetail,
  QueueItemExpiredError,
  type ShippingDestination,
  type SpendContext,
  SpendingLimitExceededError,
  type SupervisorApprovalPayload,
  type SupervisorApprovalSubmission,
  UnauthorizedSupervisorError,
  VelocityLimitExceededError,
} from "./lib/types/policy.js";
// Spend velocity tracking (sliding window with bucket compression)
export {
  defaultVelocityTracker,
  ONE_HOUR_MS,
  recordSpend,
  THIRTY_DAYS_MS,
  TWENTY_FOUR_HOURS_MS,
  VelocityTracker,
  type VelocityTrackerOptions,
} from "./lib/velocity/velocityTracker.js";
