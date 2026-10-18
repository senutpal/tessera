import {
  MandateExpiredError,
  MandateSignatureError,
  MandateValidationError,
  NonceReplayError,
} from "@tessera/core";

export class DuplicateMandateNonceError extends NonceReplayError {
  constructor(
    message = "Mandate nonce has already been consumed (replay detected)",
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

export class ExpiredMandateError extends MandateExpiredError {
  constructor(message = "Mandate has expired", details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class InvalidMandateSignatureError extends MandateSignatureError {
  constructor(
    message = "Invalid cryptographic mandate signature",
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

export class MandateBindingMismatchError extends MandateValidationError {
  constructor(
    message = "Hash binding mismatch between Checkout Mandate and Payment Mandate",
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

export class MandateSchemaValidationError extends MandateValidationError {
  constructor(message = "Mandate failed schema validation", details?: Record<string, unknown>) {
    super(message, details);
  }
}
