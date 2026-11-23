import "dotenv/config";
import express from "express";
import { uploadEquipmentImage } from "./equipment-image.js";
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
  createdAt?: Date;
  updatedAt?: Date;
};

const equipment = db.collection<Equipment>("equipment");
const favorites = db.collection<{ _id: string; customerId: string; equipmentId: ObjectId }>("favorites");
const bookings = db.collection<Booking>("bookings");
const payments = db.collection("payments");
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