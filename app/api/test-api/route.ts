import { buildRequestHeaders } from '@/lib/headers';
import { jsonError, readJson } from '@/lib/http';
import { formatIssues, testApiSchema } from '@/lib/schema';
import { SafeFetchError, safeFetch, type SafeFetchErrorCode } from '@/lib/ssrf';

export const runtime = 'nodejs';

const STATUS_BY_CODE: Record<SafeFetchErrorCode, number> = {
  invalid_url: 400,
  blocked: 403,
  redirect: 502,
  timeout: 504,
  too_large: 502,
  network: 502,
};

const MAX_TEXT = 20_000;

export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body.ok) return body.response;

  const parsed = testApiSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(400, 'The request is not valid', formatIssues(parsed.error));

  try {
    const result = await safeFetch({
      url: parsed.data.apiUrl,
      method: parsed.data.apiMethod,
      headers: buildRequestHeaders(parsed.data),
    });

    let content: unknown = result.text.length > MAX_TEXT ? `${result.text.slice(0, MAX_TEXT)}\n... (truncated)` : result.text;
    try {
      content = JSON.parse(result.text);
    } catch {
      /* not JSON: show it as text */
    }
    return Response.json(
      { status: result.status, ok: result.status >= 200 && result.status < 300, contentType: result.contentType, body: content },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof SafeFetchError) return jsonError(STATUS_BY_CODE[error.code], error.message);
    console.error('Unexpected error while testing an API');
    return jsonError(500, 'Unexpected error while testing the API');
  }
}
