export type ErrorBody = {
  error: string;
  message: string;
  blockingCondition?: string;
  details?: unknown;
};

export class AppError extends Error {
  status: number;
  body: ErrorBody;

  constructor(status: number, body: ErrorBody) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, { error: "ValidationError", message, details });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Insufficient authority") {
    super(403, { error: "AuthorizationError", message });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, { error: "NotFoundError", message: `${resource} not found` });
  }
}

export class PolicyGateBlockedError extends AppError {
  constructor(blockingCondition: string, message: string) {
    super(409, { error: "PolicyGateBlockedError", message, blockingCondition });
  }
}

export class StateTransitionError extends AppError {
  constructor(message: string) {
    super(409, { error: "StateTransitionError", message });
  }
}

export class StageGateBlockedError extends AppError {
  constructor(message: string, blockingCondition?: string) {
    super(409, { error: "StageGateBlockedError", message, blockingCondition });
  }
}

export class OptimisticLockError extends AppError {
  constructor() {
    super(409, { error: "OptimisticLockError", message: "Entry version mismatch — refresh and retry" });
  }
}

export class MissingConfigurationError extends AppError {
  constructor(configKey: string) {
    super(422, { error: "MissingConfigurationError", message: `Missing or invalid configuration: ${configKey}`, blockingCondition: configKey });
  }
}
