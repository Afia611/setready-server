import "dotenv/config";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";
import { db } from "./db.js";
import {
  verifyAdmin,
  verifyOwner,
  verifyRenter,
  verifyToken,
} from "./middleware/authenticate.js";

const app = express();
const port = Number(process.env.PORT ?? 5000);

app.all("/api/auth/*splat", toNodeHandler(auth));

app.get("/api/health", async (_request, response) => {
  try {
    await db.command({ ping: 1 });
    response.json({
      status: "ok",
      service: "setready-server",
      database: "connected",
    });
  } catch (error) {
    console.error("MongoDB health check failed:", error);
    response.status(503).json({
      status: "degraded",
      service: "setready-server",
      database: "unavailable",
    });
  }
});

app.get("/api/customer/me", verifyToken, verifyRenter, (_request, response) => {
  response.json(response.locals.auth);
});

app.get("/api/owner/me", verifyToken, verifyOwner, (_request, response) => {
  response.json(response.locals.auth);
});

app.get("/api/admin/me", verifyToken, verifyAdmin, (_request, response) => {
  response.json(response.locals.auth);
});

app.listen(port, () => {
  console.log(`SetReady API listening on port ${port}`);
});