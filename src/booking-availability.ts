import type { ClientSession } from "mongodb";
import { db } from "./db.js";

export async function availableQuantity(
  equipmentId: string,
  startDate: string,
  endDate: string,
  stock: number,
  session?: ClientSession,
) {
  const rentals = await db.collection("bookings").find({
    equipmentId,
    $or: [
      { status: "paid" },
      { status: "awaiting_payment", stripeSessionId: { $exists: true } },
      { status: "awaiting_payment", checkoutExpiresAt: { $gt: new Date() } },
    ],
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  }, { session }).toArray();

  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  const changes = new Map<number, number>();
  for (const rental of rentals) {
    const from = Math.max(start, Date.parse(rental.startDate));
    const until = Math.min(end, Date.parse(rental.endDate)) + 86_400_000;
    changes.set(from, (changes.get(from) ?? 0) + rental.quantity);
    changes.set(until, (changes.get(until) ?? 0) - rental.quantity);
  }

  let reserved = 0;
  let peak = 0;
  for (const time of [...changes.keys()].sort((a, b) => a - b)) {
    reserved += changes.get(time) ?? 0;
    peak = Math.max(peak, reserved);
  }
  return Math.max(0, stock - peak);
}
