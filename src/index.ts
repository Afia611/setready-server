import "dotenv/config";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { ObjectId, type Filter, type Sort } from "mongodb";
import { availableQuantity } from "./booking-availability.js";
import { startBookingCompletionJob, type BookingStatus } from "./booking-completion.js";
import { listPage } from "./pagination.js";
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
type EquipmentStatus = "pending" | "approved" | "rejected" | "archived";

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

type Booking = {
  customerId: string;
  equipmentId: string;
  startDate: string;
  endDate: string;
  quantity: number;
  amountMinor: number;
  currency: string;
  status: BookingStatus;
  paymentStatus?: "paid";
  equipmentName?: string;
  createdAt: Date;
};

type User = {
  name: string;
  email: string;
  role?: "customer" | "owner" | "admin";
  updatedAt?: Date;
};

const equipment = db.collection<Equipment>("equipment");
const favorites = db.collection<{ _id: string; customerId: string; equipmentId: ObjectId }>("favorites");
const bookings = db.collection<Booking>("bookings");
const users = db.collection<User>("user");

const dayMs = 86_400_000;
const rentalDays: Record<RentalType, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

function parseObjectId(value: unknown): ObjectId | null {
  return typeof value === "string" && /^[a-f0-9]{24}$/i.test(value)
    ? new ObjectId(value)
    : null;
}

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
  const timestamp = date.getTime();

  if (!Number.isFinite(timestamp) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }

  return timestamp;
}

const dhakaDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Dhaka",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function todayInDhaka(): number {
  const parts = dhakaDateFormatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return Date.parse(`${year}-${month}-${day}T00:00:00.000Z`);
}

function toEquipmentRow(listing: Equipment & { _id: ObjectId }) {
  return {
    id: listing._id.toHexString(),
    name: listing.name,
    category: listing.category,
    price: listing.price,
    rentalType: listing.rentalType,
    quantity: listing.quantity,
    status: listing.status,
  };
}

function toRentalRow(booking: Booking & { _id: ObjectId }) {
  return {
    id: booking._id.toHexString(),
    equipmentId: booking.equipmentId,
    startDate: booking.startDate,
    endDate: booking.endDate,
    quantity: booking.quantity,
    amountMinor: booking.amountMinor,
    currency: booking.currency,
    status: booking.status,
  };
}

// Better Auth and Stripe must receive the request before JSON parsing.
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

app.get("/api/admin/analytics", verifyToken, verifyAdmin, async (_request, response) => {
  try {
    const [totalUsers, totalEquipment, pendingApprovals, bookingStats] =
      await Promise.all([
        users.countDocuments(),
        equipment.countDocuments(),
        equipment.countDocuments({ status: "pending" }),
        bookings.aggregate([
          {
            $facet: {
              totalBookings: [{ $count: "count" }],
              completedRentals: [
                { $match: { status: "completed" } },
                { $count: "count" },
              ],
              revenue: [
                { $match: { status: { $in: ["paid", "completed"] } } },
                { $group: { _id: "$currency", amountMinor: { $sum: "$amountMinor" } } },
                { $project: { _id: 0, currency: "$_id", amountMinor: 1 } },
                { $sort: { currency: 1 } },
              ],
              monthlyBookings: [
                {
                  $group: {
                    _id: {
                      $dateToString: {
                        format: "%Y-%m",
                        date: "$createdAt",
                        timezone: "Asia/Dhaka",
                      },
                    },
                    count: { $sum: 1 },
                  },
                },
                { $project: { _id: 0, month: "$_id", count: 1 } },
                { $sort: { month: 1 } },
              ],
            },
          },
        ]).next(),
      ]);

    response.json({
      success: true,
      data: {
        totalUsers,
        totalEquipment,
        pendingApprovals,
        totalBookings: bookingStats?.totalBookings[0]?.count ?? 0,
        completedRentals: bookingStats?.completedRentals[0]?.count ?? 0,
        totalRevenue: bookingStats?.revenue ?? [],
        monthlyBookings: bookingStats?.monthlyBookings ?? [],
      },
    });
  } catch (error) {
    console.error("Could not load admin analytics", error);
    response.status(500).json({ success: false, message: "Could not load admin analytics." });
  }
});

app.get("/api/owner/analytics", verifyToken, verifyOwner, async (_request, response) => {
  try {
    const ownerId: string = response.locals.auth.userId;
    const [totalListedEquipment, rentalStats] = await Promise.all([
      equipment.countDocuments({ ownerId, status: { $ne: "archived" } }),
      equipment.aggregate([
        { $match: { ownerId } },
        { $project: { equipmentId: { $toString: "$_id" } } },
        {
          $lookup: {
            from: "bookings",
            localField: "equipmentId",
            foreignField: "equipmentId",
            as: "rental",
          },
        },
        { $unwind: "$rental" },
        { $replaceRoot: { newRoot: "$rental" } },
        { $match: { status: { $in: ["paid", "completed"] } } },
        {
          $facet: {
            completedRentals: [
              { $match: { status: "completed" } },
              { $count: "count" },
            ],
            earnings: [
              { $group: { _id: "$currency", amountMinor: { $sum: "$amountMinor" } } },
              { $project: { _id: 0, currency: "$_id", amountMinor: 1 } },
              { $sort: { currency: 1 } },
            ],
            monthlyEarnings: [
              { $match: { paidAt: { $type: "date" } } },
              {
                $group: {
                  _id: {
                    month: {
                      $dateToString: {
                        format: "%Y-%m",
                        date: "$paidAt",
                        timezone: "Asia/Dhaka",
                      },
                    },
                    currency: "$currency",
                  },
                  amountMinor: { $sum: "$amountMinor" },
                },
              },
              {
                $project: {
                  _id: 0,
                  month: "$_id.month",
                  currency: "$_id.currency",
                  amountMinor: 1,
                },
              },
              { $sort: { month: 1, currency: 1 } },
            ],
          },
        },
      ]).next(),
    ]);

    response.json({
      success: true,
      data: {
        totalListedEquipment,
        completedRentals: rentalStats?.completedRentals[0]?.count ?? 0,
        totalEarnings: rentalStats?.earnings ?? [],
        monthlyEarnings: rentalStats?.monthlyEarnings ?? [],
      },
    });
  } catch (error) {
    console.error("Could not load owner analytics", error);
    response.status(500).json({ success: false, message: "Could not load owner analytics." });
  }
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
    const result = await equipment.insertOne({
      ...fields,
      price,
      quantity,
      rentalType,
      ownerId: response.locals.auth.userId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    response.status(201).json({
      id: result.insertedId.toHexString(),
      status: "pending",
    });
  },
);

app.get(
  "/api/owner/equipment",
  verifyToken,
  verifyOwner,
  async (_request, response) => {
    const listings = await equipment
      .find({
        ownerId: response.locals.auth.userId,
        status: { $ne: "archived" },
      })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    response.set("Cache-Control", "no-store").json({
      data: listings.map(toEquipmentRow),
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

    response.set("Cache-Control", "no-store").json({
      data: listings.map(({ _id, ...listing }) => ({
        id: _id.toHexString(),
        ...listing,
      })),
    });
  },
);

// Register this before the Admin /:id route.
app.get(
  "/api/admin/equipment/all",
  verifyToken,
  verifyAdmin,
  async (_request, response) => {
    const listings = await equipment
      .find({})
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    response.set("Cache-Control", "no-store").json({
      data: listings.map(toEquipmentRow),
    });
  },
);

app.patch(
  "/api/admin/equipment/:id/status",
  verifyToken,
  verifyAdmin,
  async (request, response) => {
    const id = parseObjectId(request.params.id);
    const status: unknown = request.body?.status;

    if (!id) {
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
      { _id: id, status: { $ne: "archived" } },
      { $set: { status, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      response.status(404).json({ message: "Equipment not found." });
      return;
    }

    response.json({ id: id.toHexString(), status });
  },
);

function registerEquipmentManagement(
  path: string,
  verifyRole: typeof verifyOwner,
  scope: "owner" | "admin",
) {
  function activeListing(id: ObjectId, userId: string) {
    return {
      _id: id,
      status: { $ne: "archived" as const },
      ...(scope === "owner" ? { ownerId: userId } : {}),
    };
  }

  app.get(path, verifyToken, verifyRole, async (request, response) => {
    const id = parseObjectId(request.params.id);

    if (!id) {
      response.status(400).json({ message: "Invalid equipment ID." });
      return;
    }

    const listing = await equipment.findOne(
      activeListing(id, response.locals.auth.userId),
    );

    if (!listing) {
      response.status(404).json({ message: "Listing not found." });
      return;
    }

    response.set("Cache-Control", "no-store").json({
      data: {
        name: listing.name,
        description: listing.description,
        price: listing.price,
        quantity: listing.quantity,
        status: listing.status,
      },
    });
  });

  app.patch(path, verifyToken, verifyRole, async (request, response) => {
    const id = parseObjectId(request.params.id);
    const body = request.body ?? {};
    const name = readText(body.name);
    const description = readText(body.description);
    const { price, quantity } = body;

    if (!id) {
      response.status(400).json({ message: "Invalid equipment ID." });
      return;
    }

    if (!name || !description) {
      response.status(400).json({ message: "Enter a name and description." });
      return;
    }

    if (
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price <= 0 ||
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1
    ) {
      response.status(400).json({
        message: "Enter a positive price and a whole quantity of at least 1.",
      });
      return;
    }

    const changes: Partial<Equipment> = {
      name,
      description,
      price,
      quantity,
      updatedAt: new Date(),
    };

    if (scope === "owner") {
      changes.status = "pending";
    }

    const result = await equipment.updateOne(
      activeListing(id, response.locals.auth.userId),
      { $set: changes },
    );

    if (result.matchedCount === 0) {
      response.status(404).json({ message: "Listing not found." });
      return;
    }

    response.json({
      message:
        scope === "owner"
          ? "Listing saved and sent for review."
          : "Listing saved.",
    });
  });

  app.delete(path, verifyToken, verifyRole, async (request, response) => {
    const id = parseObjectId(request.params.id);

    if (!id) {
      response.status(400).json({ message: "Invalid equipment ID." });
      return;
    }

    const result = await equipment.updateOne(
      activeListing(id, response.locals.auth.userId),
      { $set: { status: "archived", updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      response.status(404).json({ message: "Listing not found." });
      return;
    }

    response.json({ message: "Listing archived." });
  });
}

registerEquipmentManagement("/api/owner/equipment/:id", verifyOwner, "owner");
registerEquipmentManagement("/api/admin/equipment/:id", verifyAdmin, "admin");

app.get("/api/equipment", async (request, response) => {
  const search = readText(request.query.search).slice(0, 120);
  const category = readText(request.query.category);
  const rentalType = readText(request.query.rentalType);
  const availability = readText(request.query.availability);
  const minimum = readText(request.query.minPrice);
  const maximum = readText(request.query.maxPrice);
  const minPrice = minimum === "" ? undefined : Number(minimum);
  const maxPrice = maximum === "" ? undefined : Number(maximum);

  if ((minPrice !== undefined && (!Number.isFinite(minPrice) || minPrice < 0)) ||
      (maxPrice !== undefined && (!Number.isFinite(maxPrice) || maxPrice < 0)) ||
      (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice)) {
    response.status(400).json({ message: "Enter a valid price range." });
    return;
  }

  const match: Filter<Equipment> = { status: "approved" };
  if (search) {
    const literal = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const term = { $regex: literal, $options: "i" };
    match.$or = [{ name: term }, { location: term }, { brand: term }];
  }
  if (category) match.category = category;
  if (rentalType === "daily" || rentalType === "weekly" || rentalType === "monthly") {
    match.rentalType = rentalType;
  }
  if (availability === "available") match.quantity = { $gt: 0 };
  if (availability === "out-of-stock") match.quantity = { $lte: 0 };
  if (minPrice !== undefined || maxPrice !== undefined) {
    match.price = {
      ...(minPrice !== undefined ? { $gte: minPrice } : {}),
      ...(maxPrice !== undefined ? { $lte: maxPrice } : {}),
    };
  }

  const sort: Sort = request.query.sort === "price-asc"
    ? { price: 1, _id: -1 }
    : request.query.sort === "price-desc"
      ? { price: -1, _id: -1 }
      : { createdAt: -1, _id: -1 };

  const [{ rows: listings, pagination }, categories] = await Promise.all([
    listPage(equipment, match, sort, request.query.page, 9),
    equipment.distinct("category", { status: "approved" }),
  ]);

  response.json({
    data: listings.map(({ _id, ...listing }) => ({ id: _id.toHexString(), ...listing })),
    pagination,
    categories: categories.filter(Boolean).sort((a, b) => a.localeCompare(b, "en")),
  });
});

app.get("/api/favorites", verifyToken, verifyRenter, async (_request, response) => {
  const saved = await favorites.find({ customerId: response.locals.auth.userId }).toArray();
  const items = await equipment.find({
    _id: { $in: saved.map((favorite) => favorite.equipmentId) },
  }).toArray();
  response.set("Cache-Control", "no-store").json({
    data: items.map(({ _id, name, category, status }) => ({
      id: _id.toHexString(), name, category, available: status === "approved",
    })),
  });
});

app.put("/api/favorites/:id", verifyToken, verifyRenter, async (request, response) => {
  const id = parseObjectId(request.params.id);
  if (!id || !await equipment.findOne({ _id: id, status: "approved" })) {
    response.status(404).json({ message: "Equipment not found." });
    return;
  }
  const customerId: string = response.locals.auth.userId;
  await favorites.updateOne(
    { _id: `${customerId}:${id.toHexString()}` },
    { $setOnInsert: { customerId, equipmentId: id } },
    { upsert: true },
  );
  response.sendStatus(204);
});

app.delete("/api/favorites/:id", verifyToken, verifyRenter, async (request, response) => {
  const id = parseObjectId(request.params.id);
  if (!id) {
    response.status(400).json({ message: "Invalid equipment ID." });
    return;
  }
  await favorites.deleteOne({ _id: `${response.locals.auth.userId}:${id.toHexString()}` });
  response.sendStatus(204);
});

app.get("/api/equipment/:id", verifyToken, async (request, response) => {
  const id = parseObjectId(request.params.id);

  if (!id) {
    response.status(400).json({ message: "Invalid equipment ID." });
    return;
  }

  const listing = await equipment.findOne({ _id: id, status: "approved" });

  if (!listing) {
    response.status(404).json({ message: "Equipment not found." });
    return;
  }

  const { _id, ownerId, ...details } = listing;
  const ownerObjectId = parseObjectId(ownerId);
  const owner = ownerObjectId
    ? await users.findOne({ _id: ownerObjectId }, { projection: { name: 1 } })
    : null;
  const isCustomer = response.locals.auth.role === "customer";
  const isFavorite = isCustomer && Boolean(await favorites.findOne({
    _id: `${response.locals.auth.userId}:${_id.toHexString()}`,
  }));

  response.set("Cache-Control", "no-store").json({
    data: { id: _id.toHexString(), ...details, ownerName: owner?.name, isCustomer, isFavorite },
  });
});

app.post(
  "/api/bookings/quote",
  verifyToken,
  verifyRenter,
  async (request, response) => {
    const { equipmentId, startDate, endDate, quantity } = request.body ?? {};
    const id = parseObjectId(equipmentId);

    if (!id) {
      response.status(400).json({ message: "Invalid equipment ID." });
      return;
    }

    const start = parseRentalDate(startDate);
    const end = parseRentalDate(endDate);

    if (start === null || end === null || end < start || start < todayInDhaka()) {
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

    const listing = await equipment.findOne({ _id: id, status: "approved" });

    if (!listing) {
      response.status(404).json({ message: "Equipment not found." });
      return;
    }

    const available = await availableQuantity(id.toHexString(), startDate, endDate, listing.quantity);
    if (quantity > available) {
      response.status(409).json({
        message: `Only ${available} units are available for those dates.`,
      });
      return;
    }

    const days = (end - start) / dayMs + 1;
    const periods = Math.ceil(days / rentalDays[listing.rentalType]);
    const totalMinor = Math.round(listing.price * 100) * periods * quantity;

    if (!Number.isSafeInteger(totalMinor) || totalMinor < 1) {
      response.status(400).json({ message: "Invalid rental total." });
      return;
    }

    response.json({
      data: {
        equipmentId: id.toHexString(),
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

app.get(
  "/api/bookings/mine",
  verifyToken,
  verifyRenter,
  async (request, response) => {
    const { rows: rentals, pagination } = await listPage(
      bookings, { customerId: response.locals.auth.userId },
      { createdAt: -1, _id: -1 }, request.query.page, 10,
    );

    const ids = [...new Set(rentals.map((rental) => rental.equipmentId))]
      .map(parseObjectId)
      .filter((id): id is ObjectId => id !== null);
    const listings = await equipment.find({ _id: { $in: ids } })
      .project<{ _id: ObjectId; name: string }>({ name: 1 }).toArray();
    const names = new Map(listings.map(({ _id, name }) => [_id.toHexString(), name]));

    response.set("Cache-Control", "no-store").json({
      pagination,
      data: rentals.map((rental) => ({
        ...toRentalRow(rental),
        equipmentName: rental.equipmentName ?? names.get(rental.equipmentId) ?? "Unavailable equipment",
        createdAt: rental.createdAt,
        paymentStatus: rental.paymentStatus ?? (rental.status === "paid" || rental.status === "completed" ? "paid" : "unpaid"),
      })),
    });
  },
);

app.get(
  "/api/owner/rentals",
  verifyToken,
  verifyOwner,
  async (request, response) => {
    // Include archived equipment so its bookings remain in rental history.
    const listings = await equipment
      .find({ ownerId: response.locals.auth.userId })
      .project<{ _id: ObjectId; name: string }>({ name: 1 })
      .toArray();

    const names = new Map(
      listings.map(({ _id, name }) => [_id.toHexString(), name]),
    );

    const { rows: rentals, pagination } = await listPage(
      bookings, { equipmentId: { $in: [...names.keys()] } },
      { createdAt: -1, _id: -1 }, request.query.page, 10,
    );

    response.set("Cache-Control", "no-store").json({
      pagination,
      data: rentals.map((booking) => ({
        ...toRentalRow(booking),
        equipmentName: names.get(booking.equipmentId) ?? "Equipment",
      })),
    });
  },
);

app.get(
  "/api/admin/rentals",
  verifyToken,
  verifyAdmin,
  async (request, response) => {
    const { rows: rentals, pagination } = await listPage(
      bookings, {}, { createdAt: -1, _id: -1 }, request.query.page, 10,
    );

    const listingIds = [...new Set(rentals.map((booking) => booking.equipmentId))]
      .map(parseObjectId)
      .filter((id): id is ObjectId => id !== null);

    const listings = await equipment
      .find({ _id: { $in: listingIds } })
      .project<{ _id: ObjectId; name: string }>({ name: 1 })
      .toArray();

    const names = new Map(
      listings.map(({ _id, name }) => [_id.toHexString(), name]),
    );

    response.set("Cache-Control", "no-store").json({
      pagination,
      data: rentals.map((booking) => ({
        ...toRentalRow(booking),
        equipmentName: names.get(booking.equipmentId) ?? "Unavailable equipment",
      })),
    });
  },
);

app.get(
  "/api/admin/users",
  verifyToken,
  verifyAdmin,
  async (_request, response) => {
    const accounts = await users
      .find({}, { projection: { name: 1, email: 1, role: 1 } })
      .sort({ email: 1 })
      .toArray();

    response.set("Cache-Control", "no-store").json({
      data: accounts.map(({ _id, name, email, role }) => ({
        id: _id.toHexString(),
        name,
        email,
        role,
      })),
    });
  },
);

app.patch(
  "/api/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (request, response) => {
    const id = parseObjectId(request.params.id);
    const role: unknown = request.body?.role;

    if (!id) {
      response.status(400).json({ message: "Invalid user ID." });
      return;
    }

    if (role !== "customer" && role !== "owner" && role !== "admin") {
      response.status(400).json({ message: "Invalid role." });
      return;
    }

    if (id.toHexString() === response.locals.auth.userId) {
      response.status(409).json({ message: "You cannot change your own role." });
      return;
    }

    const result = await users.updateOne(
      { _id: id },
      { $set: { role, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      response.status(404).json({ message: "User not found." });
      return;
    }

    response.json({ id: id.toHexString(), role });
  },
);

app.listen(port, () => {
  console.log(`SetReady API listening on port ${port}`);
  startBookingCompletionJob();
});