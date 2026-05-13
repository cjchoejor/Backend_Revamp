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
  constructor(blockingCondition: string, message: string, details?: unknown) {
    super(409, {
      error: "PolicyGateBlockedError",
      message,
      blockingCondition,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class StateTransitionError extends AppError {
  constructor(message: string, blockingCondition?: string, details?: unknown) {
    super(409, { error: "StateTransitionError", message, blockingCondition, details });
  }
}

export class StageGateBlockedError extends AppError {
  constructor(message: string, blockingCondition?: string) {
    super(409, { error: "StageGateBlockedError", message, blockingCondition });
  }
}

export type StageGateFailureItem = { blockingCondition: string; message: string };

/** Multiple S8→S9 (or similar) stage gates failed — `details.failures` lists each blocker. */
export class StageGatesBlockedError extends AppError {
  constructor(failures: StageGateFailureItem[]) {
    const list = failures.length ? failures : [{ blockingCondition: "UNKNOWN", message: "Stage transition blocked" }];
    const body: ErrorBody = {
      error: "StageGatesBlockedError",
      message:
        list.length === 1
          ? list[0].message
          : `S8→S9 blocked by ${list.length} stage gates — see details.failures`,
      blockingCondition: list.length === 1 ? list[0].blockingCondition : "MULTIPLE_STAGE_GATES",
      details: { failures: list },
    };
    super(409, body);
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
