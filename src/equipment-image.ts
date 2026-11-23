import type { RequestHandler } from "express";

export const uploadEquipmentImage: RequestHandler = async (request, response) => {
  const key = process.env.IMGBB_API_KEY?.trim();
  if (!key) {
    response.status(503).json({ message: "Image upload is not configured. Enter a direct image URL instead." });
    return;
  }

  const image: unknown = request.body;
  const type = request.get("content-type")?.split(";")[0];
  const supported = type === "image/jpeg" || type === "image/png" || type === "image/webp";
  if (!Buffer.isBuffer(image) || image.length === 0 || !supported) {
    response.status(400).json({ message: "Choose a JPEG, PNG, or WebP image up to 3 MB." });
    return;
  }

  const data = new FormData();
  data.set("image", new Blob([new Uint8Array(image)], { type }), "equipment-photo");
  const url = new URL("https://api.imgbb.com/1/upload");
  url.searchParams.set("key", key);

  try {
    const upstream = await fetch(url, { method: "POST", body: data, signal: AbortSignal.timeout(15_000) });
    const result = await upstream.json() as { success?: boolean; data?: { url?: string } };
    if (!upstream.ok || !result.success || !result.data?.url?.startsWith("https://")) {
      response.status(502).json({ message: "ImgBB could not upload that image. Try a different file." });
      return;
    }
    response.json({ imageUrl: result.data.url });
  } catch {
    response.status(502).json({ message: "Image upload could not reach ImgBB. Try again." });
  }
};
