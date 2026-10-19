import type { PluginRequest } from '@/lib/schema';

/**
 * The request headers shared by the "Test API" feature and by every generated plugin,
 * so that what is tested is what the plugin will send.
 */
export function buildRequestHeaders(config: Pick<PluginRequest, 'apiKey' | 'headers'>): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  for (const [name, value] of Object.entries(config.headers)) headers[name] = value;
  return headers;
}
