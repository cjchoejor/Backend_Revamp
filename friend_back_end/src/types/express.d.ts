import type { RequestActor } from "./actor.js";

declare global {
  namespace Express {
    interface Request {
      actor?: RequestActor;
    }
  }
}

export {};

