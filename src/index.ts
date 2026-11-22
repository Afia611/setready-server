import "dotenv/config";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { ObjectId } from "mongodb";
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

type RentalType = "daily" | "weekly" | "monthly";
type EquipmentStatus = "pending" | "approved" | "rejected";

type Equipment = {
  name: string;
  description: string;
  category: string;
  location: string;
  price: number;
  rentalType: RentalType;
  quantity: number;
  condition: string;
  brand: string;
  model: string;
  imageUrl: string;
  rentalTerms: string;
  ownerId: string;
  status: EquipmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

const equipment = db.collection<Equipment>("equipment");

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Mount Better Auth before Express parses JSON for the other routes.
app.all("/api/auth/*splat", toNodeHandler(auth));
app.use(express.json());

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

app.post(
  "/api/owner/equipment",
  verifyToken,
  verifyOwner,
  async (request, response) => {
    const body = request.body ?? {};
    const fields = {
      name: readText(body.name),
      description: readText(body.description),
      category: readText(body.category),
      location: readText(body.location),
      condition: readText(body.condition),
      brand: readText(body.brand),
      model: readText(body.model),
      imageUrl: readText(body.imageUrl),
      rentalTerms: readText(body.rentalTerms),
    };
    const { price, quantity, rentalType } = body;

    if (Object.values(fields).some((value) => !value)) {
      response.status(400).json({ message: "Fill in all equipment fields." });
      return;
    }

    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      response.status(400).json({ message: "Price must be a positive number." });
      return;
    }

    if (
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1
    ) {
      response.status(400).json({
        message: "Quantity must be a positive whole number.",
      });
      return;
    }

    if (
      rentalType !== "daily" &&
      rentalType !== "weekly" &&
      rentalType !== "monthly"
    ) {
      response.status(400).json({
        message: "Rental type must be daily, weekly, or monthly.",
      });
      return;
    }

    if (!isHttpUrl(fields.imageUrl)) {
      response.status(400).json({
        message: "Enter a valid HTTP or HTTPS image URL.",
      });
      return;
    }

    const now = new Date();
    const listing: Equipment = {
      ...fields,
      price,
      quantity,
      rentalType,
      ownerId: response.locals.auth.userId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const result = await equipment.insertOne(listing);

    response.status(201).json({
      id: result.insertedId.toHexString(),
      status: listing.status,
    });
  },
);

app.get(
  "/api/admin/equipment",
  verifyToken,
  verifyAdmin,
  async (_request, response) => {
    const listings = await equipment
      .find({ status: "pending" })
      .sort({ createdAt: -1 })
      .toArray();

    response.json({
      data: listings.map(({ _id, ...listing }) => ({
        id: _id.toHexString(),
        ...listing,
      })),
    });
  },
);

app.patch(
  "/api/admin/equipment/:id/status",
  verifyToken,
  verifyAdmin,
  async (request, response) => {
    const { id } = request.params;
    const status = request.body?.status;

    if (typeof id !== "string" || !ObjectId.isValid(id)) {
      response.status(400).json({ message: "Invalid equipment ID." });
      return;
    }

    if (status !== "approved" && status !== "rejected") {
      response.status(400).json({
        message: "Status must be approved or rejected.",
      });
      return;
    }

    const result = await equipment.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      response.status(404).json({ message: "Equipment not found." });
      return;
    }

    response.json({ id, status });
  },
);

app.get("/api/equipment", async (_request, response) => {
  const listings = await equipment
    .find({ status: "approved" })
    .sort({ createdAt: -1 })
    .toArray();

  response.json({
    data: listings.map(({ _id, ...listing }) => ({
      id: _id.toHexString(),
      ...listing,
    })),
  });
});
app.get("/api/equipment/:id", verifyToken, async (request, response) => {
  const { id } = request.params;

  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    response.status(400).json({ message: "Invalid equipment ID." });
    return;
  }

  const listing = await equipment.findOne({
    _id: new ObjectId(id),
    status: "approved",
  });

  if (!listing) {
    response.status(404).json({ message: "Equipment not found." });
    return;
  }

  const { _id, ...details } = listing;
  response.json({ data: { id: _id.toHexString(), ...details } });
});
app.listen(port, () => {
  console.log(`SetReady API listening on port ${port}`);
});