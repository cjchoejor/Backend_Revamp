import { Router } from "express";
import {
  createDepartmentRequestSchema,
  createRoleRequestSchema,
  setRolePermissionsRequestSchema,
  updateDepartmentRequestSchema,
  updateHotelProfileRequestSchema,
  updateRoleRequestSchema,
  upsertRoleSessionConfigRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as hotelProfileAdminService from "../../services/admin/hotel-profile-admin-service.js";
import * as departmentAdminService from "../../services/admin/department-admin-service.js";
import * as roleAdminService from "../../services/admin/role-admin-service.js";

export const adminIdentityRouter = Router();

// --- Hotel profile ------------------------------------------------------

adminIdentityRouter.get("/hotel-profile", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const item = await hotelProfileAdminService.getHotelProfile(prisma);
    res.json(item);
  } catch (e) {
    next(e);
  }
});

adminIdentityRouter.patch(
  "/hotel-profile",
  requireActorLevel("L4"),
  validateBody(updateHotelProfileRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await hotelProfileAdminService.updateHotelProfile(prisma, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

// --- Departments --------------------------------------------------------

adminIdentityRouter.get("/departments", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const items = await departmentAdminService.listDepartments(prisma, { includeInactive });
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminIdentityRouter.post(
  "/departments",
  requireActorLevel("L4"),
  validateBody(createDepartmentRequestSchema),
  async (req, res, next) => {
    try {
      const created = await departmentAdminService.createDepartment(prisma, req.body, req.actor!.actorId);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

adminIdentityRouter.patch(
  "/departments/:id",
  requireActorLevel("L4"),
  validateBody(updateDepartmentRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await departmentAdminService.updateDepartment(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

// --- Roles + permissions + session config ------------------------------

adminIdentityRouter.get("/roles", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const items = await roleAdminService.listRoles(prisma, { includeInactive });
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminIdentityRouter.post("/roles", requireActorLevel("L4"), validateBody(createRoleRequestSchema), async (req, res, next) => {
  try {
    const created = await roleAdminService.createRole(prisma, req.body, req.actor!.actorId);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

adminIdentityRouter.patch("/roles/:id", requireActorLevel("L4"), validateBody(updateRoleRequestSchema), async (req, res, next) => {
  try {
    const updated = await roleAdminService.updateRole(prisma, req.params.id, req.body, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

adminIdentityRouter.delete("/roles/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const result = await roleAdminService.deleteRole(prisma, req.params.id, req.actor!.actorId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

adminIdentityRouter.put(
  "/roles/:id/permissions",
  requireActorLevel("L4"),
  validateBody(setRolePermissionsRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await roleAdminService.setRolePermissions(prisma, req.params.id, req.body.permissionIds, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

adminIdentityRouter.put(
  "/roles/:id/session-config",
  requireActorLevel("L4"),
  validateBody(upsertRoleSessionConfigRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await roleAdminService.upsertRoleSessionConfig(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

