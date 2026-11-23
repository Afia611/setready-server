import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { db, mongoClient } from "./db.js";

const clientOrigins = (
  process.env.CLIENT_ORIGINS ??
  "http://localhost:3000,http://127.0.0.1:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function validateProfile(body: Record<string, unknown> = {}) {
  const { name, image, contactEmail, phone, address } = body;
  const fields = { name, image, contactEmail, phone, address };
  const limits = { name: 100, image: 2048, contactEmail: 254, phone: 30, address: 500 };

  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = fields[key];
    if (value !== undefined && !(key === "image" && value === null) &&
        (typeof value !== "string" || value.length > limits[key])) {
      throw new APIError("BAD_REQUEST", { message: `Invalid profile field: ${key}.` });
    }
  }

  if (typeof name === "string" && !name.trim()) {
    throw new APIError("BAD_REQUEST", { message: "Enter your name." });
  }
  if (typeof contactEmail === "string" && contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new APIError("BAD_REQUEST", { message: "Enter a valid contact email." });
  }
  if (typeof image === "string" && image && !/^https?:\/\//i.test(image)) {
    throw new APIError("BAD_REQUEST", { message: "Enter a valid photo URL beginning with http:// or https://." });
  }
}

function validateSignUp(body: unknown) {
  if (!body || typeof body !== "object") {
    return;
  }

  const { image, password } = body as { image?: unknown; password?: unknown };

  if (
    typeof password !== "string" ||
    password.length < 6 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password)
  ) {
    throw new APIError("BAD_REQUEST", {
      message:
        "Password must be at least 6 characters and include uppercase and lowercase letters.",
    });
  }

  if (typeof image !== "string" || !image.trim()) {
    throw new APIError("BAD_REQUEST", {
      message: "Photo URL is required.",
    });
  }

  try {
    const photoUrl = new URL(image);
    if (photoUrl.protocol !== "http:" && photoUrl.protocol !== "https:") {
      throw new Error("Unsupported photo URL protocol.");
    }
  } catch {
    throw new APIError("BAD_REQUEST", {
      message: "Photo URL must be a valid http(s) URL.",
    });
  }
}

export const auth = betterAuth({
  database: mongodbAdapter(db, { client: mongoClient }),
  trustedOrigins: clientOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (context.path === "/sign-up/email") {
        validateSignUp(context.body);
      }
      if (context.path === "/update-user") {
        validateProfile(context.body);
      }
    }),
  },
  user: {
    additionalFields: {
      contactEmail: { type: "string", required: false },
      phone: { type: "string", required: false },
      address: { type: "string", required: false },
      role: {
        type: "string",
        required: false,
        defaultValue: "customer",
        input: false,
      },
    },
  },
  plugins: [jwt()],
});