export interface DomainErrorJson {
  name: string;
  code: string;
  message: string;
  httpStatus: number;
  timestamp: string;
  details: Record<string, unknown>;
}

export class DomainError extends Error {
  public override readonly name: string;
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly timestamp: string;
  public readonly details: Record<string, unknown>;

  constructor(
    message: string,
    code = "DOMAIN_ERROR",
    httpStatus = 400,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.timestamp = new Date().toISOString();
    this.details = details;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  public toJSON(): DomainErrorJson {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      timestamp: this.timestamp,
      details: this.details,
    };
  }
}

export class MandateValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "MANDATE_VALIDATION_ERROR", 400, details);
  }
}

export class MandateExpiredError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "MANDATE_EXPIRED", 410, details);
  }
}

export class MandateSignatureError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "MANDATE_SIGNATURE_INVALID", 401, details);
  }
}

export class NonceReplayError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "NONCE_ALREADY_USED", 409, details);
  }
}

export class PolicyViolationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "POLICY_VIOLATION", 403, details);
  }
}

export class EscrowAuthorizationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "ESCROW_AUTHORIZATION_FAILED", 402, details);
  }
}

export class EscrowCaptureError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "ESCROW_CAPTURE_FAILED", 409, details);
  }
}

export class EscrowVoidError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "ESCROW_VOID_FAILED", 409, details);
  }
}

export class CarrierTrackingError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CARRIER_TRACKING_ERROR", 422, details);
  }
}

export class DisputeError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "DISPUTE_ERROR", 409, details);
  }
}

export class CanonicalJsonError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CANONICAL_JSON_ERROR", 400, details);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "NOT_FOUND", 404, details);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFLICT", 409, details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "UNAUTHORIZED", 401, details);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
