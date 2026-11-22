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
import { createStripeCheckout, stripeWebhook } from "./stripe-webhook.js";

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

function parseRentalDate(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }

  return date.getTime();
}

// Better Auth and Stripe need access to the body before JSON parsing.
app.all("/api/auth/*splat", toNodeHandler(auth));
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhook,
);

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

app.post(
  "/api/bookings/quote",
  verifyToken,
  verifyRenter,
  async (request, response) => {
    const { equipmentId, startDate, endDate, quantity } = request.body ?? {};

    if (typeof equipmentId !== "string" || !ObjectId.isValid(equipmentId)) {
      response.status(400).json({ message: "Invalid equipment ID." });
      return;
    }

    const start = parseRentalDate(startDate);
    const end = parseRentalDate(endDate);
    const todayInDhaka = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    if (
      start === null ||
      end === null ||
      end < start ||
      startDate < todayInDhaka
    ) {
      response.status(400).json({
        message: "Choose valid rental dates starting today or later.",
      });
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

    const listing = await equipment.findOne({
      _id: new ObjectId(equipmentId),
      status: "approved",
    });

    if (!listing) {
      response.status(404).json({ message: "Equipment not found." });
      return;
    }

    if (quantity > listing.quantity) {
      response.status(409).json({
        message: `This listing has a maximum of ${listing.quantity} units.`,
      });
      return;
    }

    const days = (end - start) / 86_400_000 + 1;
    const daysPerPeriod = { daily: 1, weekly: 7, monthly: 30 };
    const periods = Math.ceil(days / daysPerPeriod[listing.rentalType]);
    const totalMinor = Math.round(listing.price * 100) * periods * quantity;

    if (!Number.isSafeInteger(totalMinor)) {
      response.status(400).json({ message: "The rental total is too large." });
      return;
    }

    response.json({
      data: {
        equipmentId,
        startDate,
        endDate,
        days,
        periods,
        quantity,
        currency: "BDT",
        total: totalMinor / 100,
      },
    });
  },
);
app.post(
  "/api/bookings/checkout",
  verifyToken,
  verifyRenter,
  createStripeCheckout,
);
app.post(
  "/api/bookings/webhook",
  stripeWebhook
);
app.get("/api/bookings/mine", verifyToken, verifyRenter, async (_request, response) => {
  const customerId: string = response.locals.auth.userId;

  const bookings = await db.collection("bookings")
    .find(
      { customerId },
      {
        projection: {
          equipmentId: 1,
          startDate: 1,
          endDate: 1,
          quantity: 1,
          amountMinor: 1,
          currency: 1,
          status: 1,
        },
      },
    )
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  response.set("Cache-Control", "no-store").json({
    data: bookings.map(({ _id, ...booking }) => ({
      id: _id.toHexString(),
      ...booking,
    })),
  });
});
app.get(
  "/api/owner/rentals",
  verifyToken,
  verifyOwner,
  async (_request, response) => {
    const ownerId: string = response.locals.auth.userId;

    const listings = await equipment
      .find({ ownerId })
      .project<{ _id: ObjectId; name: string }>({ name: 1 })
      .toArray();

    const equipmentNames = new Map(
      listings.map((listing) => [listing._id.toHexString(), listing.name]),
    );

    const rentals = await db
      .collection<{
        equipmentId: string;
        startDate: string;
        endDate: string;
        quantity: number;
        amountMinor: number;
        currency: string;
        status: "awaiting_payment" | "paid" | "expired";
        createdAt: Date;
      }>("bookings")
      .find(
        { equipmentId: { $in: [...equipmentNames.keys()] } },
        { projection: { stripeSessionId: 0, customerId: 0 } },
      )
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    response.set("Cache-Control", "no-store").json({
      data: rentals.map((rental) => ({
        id: rental._id.toHexString(),
        equipmentName: equipmentNames.get(rental.equipmentId) ?? "Equipment",
        startDate: rental.startDate,
        endDate: rental.endDate,
        quantity: rental.quantity,
        amountMinor: rental.amountMinor,
        currency: rental.currency,
        status: rental.status,
      })),
    });
  },
);
app.get("/api/admin/rentals", verifyToken, verifyAdmin, async (_request, response) => {
  const rentals = await db
    .collection<{
      equipmentId: string;
      startDate: string;
      endDate: string;
      quantity: number;
      amountMinor: number;
      currency: string;
      status: "awaiting_payment" | "paid" | "expired";
      createdAt: Date;
    }>("bookings")
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  const listingIds = [...new Set(rentals.map((rental) => rental.equipmentId))]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  const listings = await equipment
    .find({ _id: { $in: listingIds } })
    .project<{ _id: ObjectId; name: string }>({ name: 1 })
    .toArray();

  const names = new Map(
    listings.map((listing) => [listing._id.toHexString(), listing.name]),
  );

  response.set("Cache-Control", "no-store").json({
    data: rentals.map((rental) => ({
      id: rental._id.toHexString(),
      equipmentName: names.get(rental.equipmentId) ?? "Unavailable equipment",
      startDate: rental.startDate,
      endDate: rental.endDate,
      quantity: rental.quantity,
      amountMinor: rental.amountMinor,
      currency: rental.currency,
      status: rental.status,
    })),
  });
});
app.get("/api/admin/users", verifyToken, verifyAdmin, async (_request, response) => {
  const users = await db.collection("user")
    .find({}, { projection: { name: 1, email: 1, role: 1 } })
    .sort({ email: 1 })
    .toArray();

  response.set("Cache-Control", "no-store").json({
    data: users.map(({ _id, name, email, role }) => ({
      id: _id.toHexString(),
      name,
      email,
      role,
    })),
  });
});

app.patch("/api/admin/users/:id/role", verifyToken, verifyAdmin, async (request, response) => {
  const { id } = request.params;
  const role: unknown = request.body?.role;
  const objectIdPattern = /^[a-f0-9]{24}$/i;

  if (typeof id !== "string" || !objectIdPattern.test(id)) {
    response.status(400).json({ message: "Invalid user ID." });
    return;
  }

  if (role !== "customer" && role !== "owner" && role !== "admin") {
    response.status(400).json({ message: "Invalid role." });
    return;
  }

  const userId = new ObjectId(id);

  if (userId.toHexString() === response.locals.auth.userId) {
    response.status(409).json({ message: "You cannot change your own role." });
    return;
  }

  const result = await db.collection("user").updateOne(
    { _id: userId },
    { $set: { role, updatedAt: new Date() } },
  );

  if (result.matchedCount === 0) {
    response.status(404).json({ message: "User not found." });
    return;
  }

  response.json({ id: userId.toHexString(), role });
});
app.listen(port, () => {
  console.log(`SetReady API listening on port ${port}`);
});