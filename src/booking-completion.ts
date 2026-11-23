import cron from "node-cron";
import { ObjectId, type Filter } from "mongodb";
import { db } from "./db.js";

export type BookingStatus = "awaiting_payment" | "paid" | "expired" | "completed";

type CompletionBooking = {
  status: BookingStatus;
  customerId: string;
  equipmentId: string;
  equipmentName?: string;
  startDate: string;
  endDate: string;
  completedAt?: Date;
  nextEmailAttemptAt?: Date;
  renterEmailedAt?: Date;
  ownerEmailedAt?: Date;
};

const bookings = db.collection<CompletionBooking>("bookings");
const equipment = db.collection<{ name: string; ownerId: string }>("equipment");
const users = db.collection<{ email: string }>("user");
const rentalTimeZone = "Asia/Dhaka";
const rentalDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: rentalTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function objectId(id?: string) {
  return id && /^[a-f0-9]{24}$/i.test(id) ? new ObjectId(id) : null;
}

async function emailFor(userId?: string) {
  const id = objectId(userId);
  if (!id) return undefined;
  return (await users.findOne({ _id: id }, { projection: { email: 1 } }))?.email;
}

async function sendCompletionEmails(apiKey: string, from: string, now: Date) {
  const due: Filter<CompletionBooking> = {
    status: "completed",
    nextEmailAttemptAt: { $lte: now },
  };
  const candidates = bookings.find(due).sort({ nextEmailAttemptAt: 1, _id: 1 }).limit(100);

  for await (const { _id } of candidates) {
    // Claim the booking atomically so separate server instances cannot email it together.
    const booking = await bookings.findOneAndUpdate(
      { _id, ...due },
      { $set: { nextEmailAttemptAt: new Date(Date.now() + 15 * 60_000) } },
      { returnDocument: "after" },
    );
    if (!booking) continue;

    try {
      const id = objectId(booking.equipmentId);
      const listing = id ? await equipment.findOne({ _id: id }) : null;
      const name = booking.equipmentName || listing?.name || "your equipment";
      const recipients = [
        { role: "renter", userId: booking.customerId, sentField: "renterEmailedAt" },
        { role: "owner", userId: listing?.ownerId, sentField: "ownerEmailedAt" },
      ] as const;

      const results = await Promise.allSettled(recipients.map(async ({ role, userId, sentField }) => {
        if (booking[sentField]) return;
        const email = await emailFor(userId);
        if (!email) throw new Error(`Missing ${role} email`);

        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `booking-completed/${_id}/${role}`,
          },
          body: JSON.stringify({
            from,
            to: [email],
            subject: "Your SetReady booking is complete",
            text: `The booking for ${name} (${booking.startDate} through ${booking.endDate}) is complete. Booking reference: ${_id}.`,
          }),
        });
        if (!response.ok) throw new Error(`Email provider returned ${response.status} for ${role}`);
        await bookings.updateOne({ _id }, { $set: { [sentField]: new Date() } });
      }));

      for (const result of results) {
        if (result.status === "rejected") {
          console.error(`Could not send booking completion email for ${_id}:`, result.reason);
        }
      }
      if (results.every((result) => result.status === "fulfilled")) {
        await bookings.updateOne({ _id }, { $unset: { nextEmailAttemptAt: "" } });
      }
    } catch (error) {
      console.error(`Could not prepare completion emails for booking ${_id}:`, error);
    }
  }
}

export async function completeBookings(now = new Date()) {
  const result = await bookings.updateMany(
    { status: "paid", endDate: { $lt: rentalDate.format(now) } },
    { $set: { status: "completed", completedAt: now, nextEmailAttemptAt: now } },
  );

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.BOOKING_EMAIL_FROM?.trim();
  if (apiKey && from) await sendCompletionEmails(apiKey, from, now);
  return result.modifiedCount;
}

export function startBookingCompletionJob() {
  const task = cron.schedule("*/5 * * * *", async () => {
    try {
      await completeBookings();
    } catch (error) {
      console.error("Booking completion job failed:", error);
    }
  }, { timezone: rentalTimeZone, noOverlap: true });

  void task.execute().catch((error) => console.error("Could not start booking completion job:", error));
}
