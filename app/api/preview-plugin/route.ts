import { generatePlugin } from '@/lib/generators';
import { jsonError, readJson } from '@/lib/http';
import { decodeLogo, formatIssues, pluginRequestSchema } from '@/lib/schema';

export const runtime = 'nodejs';

/** Returns the text files of the plugin that would be generated, so the preview is the real thing. */
export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body.ok) return body.response;

  const parsed = pluginRequestSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(400, 'The request is not valid', formatIssues(parsed.error));

  const logo = decodeLogo(parsed.data.logoPng);
  if (parsed.data.logoPng && !logo) return jsonError(400, 'The logo must be a PNG image of at most 256 KB');

  const { slug, files } = generatePlugin(parsed.data, logo);
  const textFiles = Object.entries(files)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([path, content]) => ({ path, content }));
  return Response.json({ slug, files: textFiles }, { headers: { 'Cache-Control': 'no-store' } });
}
