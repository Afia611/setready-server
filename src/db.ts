import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing from the server .env file.");
}

export const mongoClient = new MongoClient(uri, {
  serverSelectionTimeoutMS: 5000,
});

export const db = mongoClient.db(process.env.DB_NAME || "setready");