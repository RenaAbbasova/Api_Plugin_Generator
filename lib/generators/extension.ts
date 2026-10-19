import { buildRequestHeaders } from '@/lib/headers';
import { htmlEscape, jsString } from '@/lib/escape';
import { slugify } from '@/lib/slug';
import type { PluginRequest } from '@/lib/schema';
import type { GeneratedFiles } from '@/lib/generators/types';

export type ExtensionTarget = 'chrome' | 'firefox';

/** The host permission is the origin plus "/*": a full URL is not a valid match pattern. */
export function hostPattern(apiUrl: string): string {
  return `${new URL(apiUrl).origin}/*`;
}

export function generateExtension(config: PluginRequest, logo: Uint8Array | null, target: ExtensionTarget): { slug: string; files: GeneratedFiles } {
  const slug = slugify(config.pluginName);
  const icons = logo ? { icons: { '128': 'icon.png' } } : {};
  const popup = { default_popup: 'popup.html', ...(logo ? { default_icon: 'icon.png' } : {}) };

  const manifest =
    target === 'chrome'
      ? {
          manifest_version: 3,
          name: config.pluginName,
          version: '1.0.0',
          description: config.description,
          host_permissions: [hostPattern(config.apiUrl)],
          action: popup,
          ...icons,
        }
      : {
          manifest_version: 2,
          name: config.pluginName,
          version: '1.0.0',
          description: config.description,
          permissions: [hostPattern(config.apiUrl)],
          browser_action: popup,
          browser_specific_settings: { gecko: { id: `${slug}@api-plugin-generator.local` } },
          ...icons,
        };

  const popupHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${htmlEscape(config.pluginName)}</title>
  <link rel="stylesheet" href="popup.css">
  <script src="popup.js" defer></script>
</head>
<body>
  <h1>${htmlEscape(config.pluginName)}</h1>
  <div id="result" aria-live="polite">Loading...</div>
${config.visualizeData ? '  <div id="visualization" class="visualization"></div>\n' : ''}</body>
</html>
`;

  const popupCss = `body {
  width: 320px;
  padding: 10px;
  font-family: Arial, sans-serif;
}
pre {
  white-space: pre-wrap;
  word-wrap: break-word;
}
.visualization {
  margin-top: 20px;
}
.data-item {
  margin-bottom: 10px;
}
`;

  const popupJs = `'use strict';

const API_URL = ${jsString(config.apiUrl)};
const API_METHOD = ${jsString(config.apiMethod)};
const HEADERS = ${JSON.stringify(buildRequestHeaders(config), null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')};
const VISUALIZE = ${config.visualizeData ? 'true' : 'false'};

function renderJson(data) {
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(data, null, 2);
  return pre;
}

function renderVisualization(data) {
  const heading = document.createElement('h2');
  heading.textContent = 'Data visualization';
  const items = [heading];
  for (const [key, value] of Object.entries(data)) {
    const item = document.createElement('div');
    item.className = 'data-item';
    const label = document.createElement('strong');
    label.textContent = key + ': ';
    item.append(label, document.createTextNode(typeof value === 'string' ? value : JSON.stringify(value)));
    items.push(item);
  }
  return items;
}

async function load() {
  const result = document.getElementById('result');
  try {
    const response = await fetch(API_URL, { method: API_METHOD, headers: HEADERS });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const data = await response.json();
    result.replaceChildren(renderJson(data));
    if (VISUALIZE && data && typeof data === 'object') {
      document.getElementById('visualization').replaceChildren(...renderVisualization(data));
    }
  } catch (error) {
    result.textContent = 'Error: ' + error.message;
  }
}

document.addEventListener('DOMContentLoaded', load);
`;

  const readme = [
    config.pluginName,
    '',
    target === 'chrome'
      ? 'Install: unzip this file, open chrome://extensions, turn on Developer mode, choose "Load unpacked" and select the folder.'
      : 'Install: open about:debugging#/runtime/this-firefox, choose "Load Temporary Add-on" and select manifest.json from the unzipped folder.',
    '',
    config.apiKey || Object.keys(config.headers).length
      ? 'WARNING: the API key and headers are stored in plain text inside popup.js. Do not share or publish this extension.'
      : 'No API key is included.',
    '',
  ].join('\n');

  const files: GeneratedFiles = {
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'popup.html': popupHtml,
    'popup.css': popupCss,
    'popup.js': popupJs,
    'README.txt': readme,
  };
  if (logo) files['icon.png'] = logo;
  return { slug, files };
}
