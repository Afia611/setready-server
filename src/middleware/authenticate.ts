import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const authUrl = process.env.BETTER_AUTH_URL?.replace(/\/+$/, "");

if (!authUrl) {
  throw new Error("BETTER_AUTH_URL is missing from the server .env file.");
}

const jwks = createRemoteJWKSet(new URL(`${authUrl}/api/auth/jwks`));

type Role = "customer" | "owner" | "admin";

export const verifyToken: RequestHandler = async (request, response, next) => {
  const match = /^Bearer\s+(\S+)$/i.exec(request.get("authorization") ?? "");

  if (!match) {
    response.status(401).json({ message: "Bearer token required." });
    return;
  }

  let userId: string | undefined;

  try {
    const { payload } = await jwtVerify(match[1], jwks, {
      issuer: authUrl,
      audience: authUrl,
      requiredClaims: ["sub", "exp"],
    });
    userId = payload.sub;
  } catch {
    response.status(401).json({ message: "Invalid or expired token." });
    return;
  }

  if (!userId || !ObjectId.isValid(userId)) {
    response.status(401).json({ message: "Invalid user ID." });
    return;
  }

  try {
    const user = await db
      .collection<{ _id: ObjectId; role?: string }>("user")
      .findOne({ _id: new ObjectId(userId) }, { projection: { role: 1 } });

    if (!user) {
      response.status(401).json({ message: "Account not found." });
      return;
    }

    response.locals.auth = { userId, role: user.role };
    next();
  } catch (error) {
    next(error);
  }
};

function requireRole(role: Role): RequestHandler {
  return (_request, response, next) => {
    if (response.locals.auth?.role !== role) {
      response.status(403).json({ message: "You do not have access." });
      return;
    }

    next();
  };
}

export const verifyRenter = requireRole("customer");
export const verifyOwner = requireRole("owner");
export const verifyAdmin = requireRole("admin");
