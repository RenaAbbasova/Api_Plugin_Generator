import { generatePlugin } from '@/lib/generators';
import { jsonError, readJson } from '@/lib/http';
import { decodeLogo, formatIssues, pluginRequestSchema } from '@/lib/schema';
import { createZip } from '@/lib/zip';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body.ok) return body.response;

  const parsed = pluginRequestSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(400, 'The request is not valid', formatIssues(parsed.error));

  const logo = decodeLogo(parsed.data.logoPng);
  if (parsed.data.logoPng && !logo) return jsonError(400, 'The logo must be a PNG image of at most 256 KB');

  const { slug, files } = generatePlugin(parsed.data, logo);
  const zip = createZip(files);

  return new Response(Buffer.from(zip), {
    headers: {
      'Content-Type': 'application/zip',
      // The file name comes from a slug (letters, digits and hyphens), never from the raw plugin name.
      'Content-Disposition': `attachment; filename="${slug}.zip"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
