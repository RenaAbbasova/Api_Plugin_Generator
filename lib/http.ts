export const MAX_BODY_BYTES = 700_000;

export function jsonError(status: number, message: string, details?: string[]): Response {
  return Response.json({ error: message, ...(details?.length ? { details } : {}) }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Reads a JSON body, refusing anything larger than MAX_BODY_BYTES or that is not valid JSON. */
export async function readJson(req: Request): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, response: jsonError(413, 'The request is too large') };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: jsonError(400, 'The request body could not be read') };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: jsonError(413, 'The request is too large') };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, response: jsonError(400, 'The request body is not valid JSON') };
  }
}
