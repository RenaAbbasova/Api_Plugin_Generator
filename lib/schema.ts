import { z } from 'zod';

const CONTROL = /[\u0000-\u001f\u007f]/;
const noControl = (value: string) => !CONTROL.test(value);

/** RFC 9110 "token": the characters allowed in an HTTP header name. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Headers the user may not set: they would break the request or are controlled by the platform. */
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive',
  'proxy-authorization', 'proxy-connection', 'cookie', 'set-cookie',
]);

export const MAX_HEADERS = 20;
export const MAX_LOGO_BYTES = 256 * 1024;

const apiUrl = z
  .string()
  .trim()
  .max(2048, 'The API URL is too long')
  .refine(noControl, 'The API URL contains control characters')
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Enter a valid http(s) URL without a username or password');

const apiMethod = z.enum(['GET', 'POST']);

const apiKey = z
  .string()
  .max(256, 'The API key is too long')
  .refine(noControl, 'The API key contains control characters')
  .default('');

const headers = z
  .record(z.string(), z.string())
  .default({})
  .superRefine((value, ctx) => {
    const entries = Object.entries(value);
    if (entries.length > MAX_HEADERS) {
      ctx.addIssue({ code: 'custom', message: `At most ${MAX_HEADERS} custom headers` });
    }
    for (const [name, content] of entries) {
      if (!HEADER_NAME.test(name)) ctx.addIssue({ code: 'custom', message: `Invalid header name: ${name.slice(0, 40)}` });
      else if (FORBIDDEN_HEADERS.has(name.toLowerCase())) ctx.addIssue({ code: 'custom', message: `The header ${name} cannot be set` });
      if (content.length > 500 || CONTROL.test(content)) ctx.addIssue({ code: 'custom', message: `Invalid value for the header ${name.slice(0, 40)}` });
    }
  });

const base = {
  pluginName: z
    .string()
    .trim()
    .min(2, 'The plugin name needs at least 2 characters')
    .max(60, 'The plugin name can have at most 60 characters')
    .regex(/^[\p{L}\p{N} _.()-]+$/u, 'Use letters, numbers, spaces and . _ - ( ) only')
    .regex(/[\p{L}\p{N}]/u, 'The plugin name needs at least one letter or number'),
  description: z
    .string()
    .trim()
    .max(132, 'The description can have at most 132 characters')
    .refine(noControl, 'The description must be a single line without control characters'),
  apiUrl,
  apiMethod,
  apiKey,
  headers,
};

/** The authorization can come from the API key or from a custom header, not from both. */
function exclusiveAuth(value: { apiKey: string; headers: Record<string, string> }, ctx: z.RefinementCtx) {
  const hasAuthHeader = Object.keys(value.headers).some((name) => name.toLowerCase() === 'authorization');
  if (value.apiKey && hasAuthHeader) {
    ctx.addIssue({ code: 'custom', path: ['headers'], message: 'Use either the API key or an Authorization header, not both' });
  }
}

export const pluginRequestSchema = z
  .object({
    ...base,
    platform: z.enum(['wordpress', 'chrome', 'firefox']),
    visualizeData: z.boolean().default(false),
    /** Optional PNG logo, sent as base64. */
    logoPng: z.string().max(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 8).optional(),
  })
  .superRefine(exclusiveAuth);

export const testApiSchema = z.object({ apiUrl, apiMethod, apiKey, headers }).superRefine(exclusiveAuth);

export type PluginRequest = z.infer<typeof pluginRequestSchema>;
export type TestApiRequest = z.infer<typeof testApiSchema>;

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decodes and verifies a base64 PNG (real signature, size limit). Returns null when it is not valid. */
export function decodeLogo(base64: string | undefined): Uint8Array | null {
  if (!base64) return null;
  const clean = base64.replace(/^data:image\/png;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  const bytes = Uint8Array.from(Buffer.from(clean, 'base64'));
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte) ? bytes : null;
}
