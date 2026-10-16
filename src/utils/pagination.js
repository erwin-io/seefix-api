import { ApiError } from "../errors.js";

export const MAX_PAGE_SIZE = 500;

/**
 * Opt-in paging for list routes (Web Admin V2 loads every page, then sorts/filters locally).
 * No `page`/`pageSize` query → null: the route keeps its legacy response. Otherwise `{ page, pageSize, limit, offset }`
 * where `limit` is pageSize + 1, so one extra row tells whether another page exists.
 * Offset paging over a total order with an Id tie-breaker; the client detects concurrent writes with the domain
 * versions (X-Data-Versions / GET /api/sync/versions) and refetches, so no snapshot is held open between pages.
 */
export function pageParams(query) {
  if (query.page === undefined && query.pageSize === undefined) return null;
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 100);
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    throw new ApiError(400, "page must be an integer from 1.", "INVALID_PAGE");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new ApiError(400, `pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}.`, "INVALID_PAGE_SIZE");
  }
  return { page, pageSize, limit: pageSize + 1, offset: (page - 1) * pageSize };
}

/** `{ items, page, pageSize, hasMore }` from rows fetched with `limit` (pageSize + 1). */
export function pageResult(rows, paging) {
  return {
    items: rows.slice(0, paging.pageSize),
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: rows.length > paging.pageSize,
  };
}
