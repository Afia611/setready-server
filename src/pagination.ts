import type { Collection, Document, Filter, Sort } from "mongodb";

export async function listPage<T extends Document>(
  collection: Collection<T>,
  filter: Filter<T>,
  sort: Sort,
  requestedPage: unknown,
  pageSize: number,
) {
  const cursor = collection.find(filter).sort(sort);

  // Keep the existing response for callers that omit pagination.
  if (requestedPage === undefined) {
    return { rows: await cursor.toArray() };
  }

  const total = await collection.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageNumber = typeof requestedPage === "string" && /^[1-9]\d*$/.test(requestedPage)
    ? Number(requestedPage)
    : 1;
  const page = Number.isSafeInteger(pageNumber) ? Math.min(pageNumber, totalPages) : 1;

  return {
    rows: await cursor.skip((page - 1) * pageSize).limit(pageSize).toArray(),
    pagination: { page, pageSize, total, totalPages },
  };
}
