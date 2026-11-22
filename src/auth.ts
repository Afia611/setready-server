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
    }),
  },
  user: {
    additionalFields: {
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