import { Router } from "express";
import { prisma } from "../../db.js";
import {
  valueOnlyRequestSchema,
  updateAIAgentConfigRequestSchema,
  setProcessingLockTTLsRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/ai-agent-config-admin-service.js";

export const adminAiAgentConfigRouter = Router();
const L4 = requireActorLevel("L4");

adminAiAgentConfigRouter.get("/ai-agent-config", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getAIAgentConfig(prisma) });
  } catch (e) {
    next(e);
  }
});
adminAiAgentConfigRouter.put("/ai-agent-config", L4, validateBody(updateAIAgentConfigRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.updateAIAgentConfig(prisma, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminAiAgentConfigRouter.get("/ai-agent-config/processing-lock-ttl", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getProcessingLockTTLs(prisma) });
  } catch (e) {
    next(e);
  }
});
adminAiAgentConfigRouter.put("/ai-agent-config/processing-lock-ttl", L4, validateBody(setProcessingLockTTLsRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setProcessingLockTTLs(prisma, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminAiAgentConfigRouter.get("/ai-agent-config/voice-note-sla", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getVoiceNoteSLAs(prisma) });
  } catch (e) {
    next(e);
  }
});
adminAiAgentConfigRouter.put("/ai-agent-config/voice-note-sla", L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setVoiceNoteSLAs(prisma, req.body.value as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminAiAgentConfigRouter.get("/ai-agent-config/voice-note-escalation", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getVoiceNoteEscalationRouting(prisma) });
  } catch (e) {
    next(e);
  }
});
adminAiAgentConfigRouter.put("/ai-agent-config/voice-note-escalation", L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setVoiceNoteEscalationRouting(prisma, req.body.value as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
