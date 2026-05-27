import { Router } from "express";
import { prisma } from "../../db.js";
import {
  createRoomRequestSchema,
  createRoomTypeRequestSchema,
  createSpaceRequestSchema,
  deficientCategoriesRequestSchema,
  updateRoomRequestSchema,
  updateRoomTypeRequestSchema,
  updateSpaceRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as inventoryAdminService from "../../services/admin/inventory-admin-service.js";

export const adminInventoryRouter = Router();

adminInventoryRouter.get("/room-types", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const items = await inventoryAdminService.listRoomTypes(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.post(
  "/room-types",
  requireActorLevel("L4"),
  validateBody(createRoomTypeRequestSchema),
  async (req, res, next) => {
    try {
      const created = await inventoryAdminService.createRoomType(prisma, req.body, req.actor!.actorId);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

adminInventoryRouter.patch(
  "/room-types/:id",
  requireActorLevel("L4"),
  validateBody(updateRoomTypeRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await inventoryAdminService.updateRoomType(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

adminInventoryRouter.delete("/room-types/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const result = await inventoryAdminService.deleteRoomType(prisma, req.params.id, req.actor!.actorId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.get("/rooms", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const items = await inventoryAdminService.listRooms(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.get("/rooms/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const item = await inventoryAdminService.getRoom(prisma, req.params.id);
    res.json(item);
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.post("/rooms", requireActorLevel("L4"), validateBody(createRoomRequestSchema), async (req, res, next) => {
  try {
    const created = await inventoryAdminService.createRoom(prisma, req.body, req.actor!.actorId);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.patch(
  "/rooms/:id",
  requireActorLevel("L4"),
  validateBody(updateRoomRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await inventoryAdminService.updateRoom(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

adminInventoryRouter.post("/rooms/:id/deactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const updated = await inventoryAdminService.deactivateRoom(
      prisma,
      req.params.id,
      req.actor!.actorId,
      typeof req.body?.blockedReason === "string" ? req.body.blockedReason : null,
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.delete("/rooms/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const result = await inventoryAdminService.deleteRoom(prisma, req.params.id, req.actor!.actorId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.get("/spaces", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const items = await inventoryAdminService.listSpaces(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.post("/spaces", requireActorLevel("L4"), validateBody(createSpaceRequestSchema), async (req, res, next) => {
  try {
    const created = await inventoryAdminService.createSpace(prisma, req.body, req.actor!.actorId);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.patch(
  "/spaces/:id",
  requireActorLevel("L4"),
  validateBody(updateSpaceRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await inventoryAdminService.updateSpace(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

adminInventoryRouter.delete("/spaces/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const result = await inventoryAdminService.deleteSpace(prisma, req.params.id, req.actor!.actorId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.get("/deficient-condition-categories", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const data = await inventoryAdminService.getDeficientCategories(prisma);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

adminInventoryRouter.patch(
  "/deficient-condition-categories",
  requireActorLevel("L4"),
  validateBody(deficientCategoriesRequestSchema),
  async (req, res, next) => {
    try {
      const result = await inventoryAdminService.setDeficientCategories(
        prisma,
        req.body.configValue,
        req.actor!.actorId,
        req.body.notes,
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);
