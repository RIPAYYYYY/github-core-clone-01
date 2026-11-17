// http.ts: the small HTTP plumbing every surface shares — request reading, JSON replies that always
// carry the forge's request id, and the {message} error shape the protocol checks require.

import type { IncomingMessage, ServerResponse } from 'node:http';

let requestSeq = 0;

/** A non-empty, unique-per-process request id (the protocol checks require the header, not a format). */
export function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(36)}-${(requestSeq * 2654435761 % 0xffffffff).toString(16)}`;
}

export interface Req {
  method: string;
  /** The raw (still percent-encoded) pathname. */
  path: string;
  /** Pathname split on '/', each segment percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** Read a request fully and shape it as a Req. */
export async function readReq(req: IncomingMessage): Promise<Req> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const segments = url.pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    segments,
    query: url.searchParams,
    headers: req.headers,
    body: Buffer.concat(chunks),
  };
}

/** The Authorization bearer's token, or null when the header is absent or not a bearer header. */
export function bearerToken(req: Req): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

/** Whether the request presents the trial's token (the one in this process's environment). */
export function tokenOk(req: Req): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true; // no token configured locally: nothing to check against
  return bearerToken(req) === expected;
}

/** Send a JSON reply. Every reply is application/json and carries the request id set by the server. */
export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...headers });
  res.end(body);
}

/** Send the standard error shape: a JSON object with a string message. */
export function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { message }, headers);
}

/** Send raw bytes with an explicit content type (git advertisements and pack results). */
export function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Send a bodyless reply (204s, MCP notifications). */
export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0 });
  res.end();
}

/**
 * Parse a JSON request body. Returns { ok: true, value } (an empty body counts as {}), or
 * { ok: false } when the body is not JSON — the caller answers 400 (REST) or its surface's parse error.
 */
export function parseJsonBody(req: Req): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const text = req.body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** A query parameter as a positive int within [min, max], or the fallback. */
export function intParam(req: Req, name: string, fallback: number, min: number, max: number): number {
  const raw = req.query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
