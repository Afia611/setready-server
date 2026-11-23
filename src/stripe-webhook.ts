import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { availableQuantity } from "./booking-availability.js";
import { db, mongoClient } from "./db.js";

type RentalQuote = {
  equipmentId: string;
  startDate: string;
  endDate: string;
  quantity: number;
  currency: string;
  total: number;
};

type Booking = {
  customerId: string;
  equipmentId: string;
  equipmentName?: string;
  startDate: string;
  endDate: string;
  quantity: number;
  amountMinor: number;
  currency: string;
  status: "awaiting_payment" | "paid" | "expired";
  contactNumber?: string;
  deliveryAddress?: string;
  notes?: string;
  checkoutExpiresAt?: Date;
  stripeSessionId?: string;
  paidAt?: Date;
  paymentStatus?: "paid";
  createdAt: Date;
};

const bookings = db.collection<Booking>("bookings");
const equipment = db.collection<{ status: string; quantity: number; name: string; checkoutVersion?: number }>("equipment");
const payments = db.collection<{ _id: string }>("payments");

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export const createStripeCheckout: RequestHandler = async (request, response) => {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  const clientUrl = process.env.CLIENT_URL?.replace(/\/+$/, "");

  if (!apiKey || !clientUrl) {
    response.status(503).json({ message: "Stripe Checkout is not configured." });
    return;
  }

  const body = request.body ?? {};
  const { startDate, endDate, quantity, checkoutKey } = body;
  const equipmentId = typeof body.equipmentId === "string" ? body.equipmentId.toLowerCase() : "";
  const contactNumber = text(body.contactNumber);
  const deliveryAddress = text(body.deliveryAddress);
  const notes = text(body.notes);

  if (!/^[+\d][\d ().-]{5,24}$/.test(contactNumber) ||
      contactNumber.replace(/\D/g, "").length < 6 ||
      !deliveryAddress || deliveryAddress.length > 500 ||
      notes.length > 1000 ||
      (body.notes != null && typeof body.notes !== "string")) {
    response.status(400).json({ message: "Enter a valid contact number and delivery address. Notes can be up to 1,000 characters." });
    return;
  }

  if (
    typeof checkoutKey !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(checkoutKey)
  ) {
    response.status(400).json({ message: "Invalid checkout request ID." });
    return;
  }

  const customerId: string = response.locals.auth.userId;
  const bookingId = new ObjectId(
    createHash("sha256")
      .update(`${customerId}:${checkoutKey}`)
      .digest("hex")
      .slice(0, 24),
  );
  const stripe = new Stripe(apiKey);

  try {
    let booking = await bookings.findOne({ _id: bookingId });

    if (!booking) {
      const port = Number(process.env.PORT ?? 5000);
      const quoteResponse = await fetch(
        `http://127.0.0.1:${port}/api/bookings/quote`,
        {
          method: "POST",
          headers: {
            authorization: request.get("authorization") ?? "",
            "content-type": "application/json",
          },
          body: JSON.stringify({ equipmentId, startDate, endDate, quantity }),
        },
      );

      if (!quoteResponse.ok) {
        const error = (await quoteResponse.json().catch(() => null)) as {
          message?: string;
        } | null;

        response.status(quoteResponse.status).json({
          message: error?.message ?? "Could not validate this rental.",
        });
        return;
      }

      const { data: quote } = (await quoteResponse.json()) as {
        data: RentalQuote;
      };
      const amountMinor = Math.round(quote.total * 100);

      if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
        response.status(400).json({ message: "Invalid checkout amount." });
        return;
      }

      const newBooking: Booking = {
        customerId,
        equipmentId: quote.equipmentId,
        startDate: quote.startDate,
        endDate: quote.endDate,
        quantity: quote.quantity,
        amountMinor,
        currency: quote.currency.toLowerCase(),
        contactNumber,
        deliveryAddress,
        notes,
        checkoutExpiresAt: new Date(Date.now() + 45 * 60_000),
        status: "awaiting_payment",
        createdAt: new Date(),
      };

      booking = await mongoClient.withSession((session) => session.withTransaction(async () => {
        const existing = await bookings.findOne({ _id: bookingId }, { session });
        if (existing) return existing;

        // Updating the listing serializes concurrent reservations for this equipment.
        const listing = await equipment.findOneAndUpdate(
          { _id: new ObjectId(quote.equipmentId), status: "approved" },
          { $inc: { checkoutVersion: 1 } },
          { session },
        );
        if (!listing) return null;

        const available = await availableQuantity(
          quote.equipmentId, quote.startDate, quote.endDate, listing.quantity, session,
        );
        if (available < quote.quantity) return null;

        const reservation = { _id: bookingId, ...newBooking, equipmentName: listing.name };
        await bookings.insertOne(reservation, { session });
        return reservation;
      }));

      if (!booking) {
        response.status(409).json({ message: "This quantity is no longer available for those dates." });
        return;
      }
    }

    if (
      booking.customerId !== customerId ||
      booking.equipmentId !== equipmentId ||
      booking.startDate !== startDate ||
      booking.endDate !== endDate ||
      booking.quantity !== quantity ||
      booking.contactNumber !== contactNumber ||
      booking.deliveryAddress !== deliveryAddress ||
      booking.notes !== notes
    ) {
      response.status(409).json({
        message: "Your rental selection changed. Refresh and try again.",
      });
      return;
    }

    if (booking.status !== "awaiting_payment") {
      response.status(409).json({
        message:
          booking.status === "paid"
            ? "This booking has already been paid."
            : "This checkout expired. Refresh to start a new checkout.",
      });
      return;
    }

    // Stripe requires a new Checkout Session to expire at least 30 minutes later.
    const expiresAt = booking.checkoutExpiresAt?.getTime() ?? 0;
    if (!booking.stripeSessionId && expiresAt - Date.now() < 30 * 60_000 + 1000) {
      response.status(409).json({
        message: "This checkout expired. Refresh to start a new checkout.",
      });
      return;
    }

    const checkout = booking.stripeSessionId
        ? await stripe.checkout.sessions.retrieve(booking.stripeSessionId)
        : await stripe.checkout.sessions.create(
            {
              mode: "payment",
              expires_at: Math.floor(expiresAt / 1000),
              client_reference_id: bookingId.toHexString(),
              line_items: [
                {
                  quantity: 1,
                  price_data: {
                    currency: booking.currency,
                    unit_amount: booking.amountMinor,
                    product_data: { name: "SetReady equipment rental" },
                  },
                },
              ],
              success_url: `${clientUrl}/booking/success`,
              cancel_url: `${clientUrl}/equipment/${encodeURIComponent(booking.equipmentId)}`,
            },
            { idempotencyKey: `setready-checkout-${bookingId.toHexString()}` },
          );
    if (checkout.status !== "open" || !checkout.url) {
      response.status(409).json({
        message:
          checkout.payment_status === "paid"
            ? "Stripe has received payment for this booking."
            : "This checkout is no longer open. Refresh to start a new checkout.",
      });
      return;
    }

    if (!booking.stripeSessionId) {
      await bookings.updateOne(
        { _id: bookingId },
        { $set: { stripeSessionId: checkout.id } },
      );
    }

    response.json({ url: checkout.url });
  } catch (error) {
    console.error("Could not open Stripe Checkout:", error);
    response.status(502).json({
      message: "Could not open Stripe Checkout. Try again.",
    });
  }
};

export const stripeWebhook: RequestHandler = async (request, response) => {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = request.get("stripe-signature");

  if (!apiKey || !webhookSecret) {
    response.status(503).json({ message: "Stripe is not configured." });
    return;
  }

  if (!signature || !Buffer.isBuffer(request.body)) {
    response.status(400).json({ message: "Missing Stripe signature or raw body." });
    return;
  }

  const stripe = new Stripe(apiKey);
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(request.body, signature, webhookSecret);
  } catch {
    response.status(400).json({ message: "Invalid Stripe webhook signature." });
    return;
  }

  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.async_payment_succeeded" &&
    event.type !== "checkout.session.async_payment_failed" &&
    event.type !== "checkout.session.expired"
  ) {
    response.json({ received: true });
    return;
  }

  try {
    const sessionId = event.data.object.id;
    const reference = event.data.object.client_reference_id;
    const booking = reference && /^[a-f0-9]{24}$/i.test(reference)
      ? await bookings.findOne({ _id: new ObjectId(reference) })
      : null;

    if (!booking) {
      // CLI test fixtures have no corresponding booking in SetReady.
      response.json({ received: true });
      return;
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (
      (booking.stripeSessionId && booking.stripeSessionId !== session.id) ||
      session.client_reference_id !== booking._id.toHexString() ||
      session.amount_total !== booking.amountMinor ||
      session.currency !== booking.currency
    ) {
      response.status(400).json({ message: "Stripe session does not match booking." });
      return;
    }

    if (session.payment_status === "paid") {
      const paidAt = booking.paidAt ?? new Date();
      const paymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;

      await mongoClient.withSession((transaction) => transaction.withTransaction(async () => {
        await payments.updateOne(
          { _id: session.id },
          { $setOnInsert: {
            bookingId: booking._id.toHexString(),
            customerId: booking.customerId,
            stripeSessionId: session.id,
            stripePaymentIntentId: paymentIntentId,
            amountMinor: booking.amountMinor,
            currency: booking.currency,
            status: "paid",
            paidAt,
          } },
          { session: transaction, upsert: true },
        );
        await bookings.updateOne(
          { _id: booking._id, status: { $ne: "paid" } },
          { $set: { status: "paid", paymentStatus: "paid", paidAt, stripeSessionId: session.id } },
          { session: transaction },
        );
      }));
    } else if (session.status === "expired" || event.type === "checkout.session.async_payment_failed") {
      await bookings.updateOne(
        { _id: booking._id, status: "awaiting_payment" },
        { $set: { status: "expired" } },
      );
    }

    console.info(`Processed Stripe event: ${event.type} (${event.id})`);
    response.json({ received: true });
  } catch (error) {
    console.error("Could not process Stripe webhook:", error);
    response.status(500).json({ message: "Could not process Stripe webhook." });
  }
};