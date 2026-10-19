import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { unzipSync, strFromU8 } from 'fflate';
import * as acorn from 'acorn';
import { describe, expect, it } from 'vitest';
import { generatePlugin } from '@/lib/generators';
import { hostPattern } from '@/lib/generators/extension';
import { pluginRequestSchema, type PluginRequest } from '@/lib/schema';
import { createZip } from '@/lib/zip';

// Hostile values, passed straight to the generators (bypassing the validation) to prove that the
// escaping alone is enough: validation is a second line of defence, not the only one.
const MARKER = path.join(os.tmpdir(), 'PWNED_BY_API_PLUGIN_GENERATOR_TEST');
const PHP_PAYLOAD = `x'); file_put_contents('${MARKER}', '1'); //`;
const HOSTILE: PluginRequest = {
  platform: 'wordpress',
  pluginName: `Evil */ file_put_contents('${MARKER}','1'); /* ${PHP_PAYLOAD}`,
  description: `*/ file_put_contents('${MARKER}','1'); // \n ?> <?php system('id');`,
  apiUrl: `https://api.example.com/?q=${PHP_PAYLOAD}\\`,
  apiMethod: 'GET',
  apiKey: `k\\'"${PHP_PAYLOAD}</script>`,
  headers: { [`X-${PHP_PAYLOAD}`]: `v\\${PHP_PAYLOAD}\n?>`, 'X-Plain': 'ok' },
  visualizeData: true,
};
const NORMAL: PluginRequest = pluginRequestSchema.parse({
  platform: 'chrome', pluginName: 'My API Viewer', description: 'Shows the data of my API', apiUrl: 'https://api.example.com/v1/items?limit=5',
  apiMethod: 'GET', apiKey: 'secret-key', headers: { 'X-Team': 'blue' }, visualizeData: true,
});
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const text = (files: Record<string, string | Uint8Array>, name: string) => {
  const v = files[name];
  if (typeof v !== 'string') throw new Error(`${name} missing or binary`);
  return v;
};

const phpAvailable = spawnSync('php', ['-v']).status === 0;

describe('WordPress plugin', () => {
  it('lays the files out as slug/slug.php', () => {
    const { slug, files } = generatePlugin(NORMAL && { ...NORMAL, platform: 'wordpress' }, png);
    expect(slug).toBe('my-api-viewer');
    expect(Object.keys(files).sort()).toEqual(['my-api-viewer/README.txt', 'my-api-viewer/assets/icon-256x256.png', 'my-api-viewer/my-api-viewer.php']);
  });

  it.skipIf(!phpAvailable)('is valid PHP, and hostile input stays plain data (executed with the real PHP interpreter)', () => {
    fs.rmSync(MARKER, { force: true });
    const { files, slug } = generatePlugin(HOSTILE, null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-test-'));
    const pluginFile = path.join(dir, `${slug}.php`);
    fs.writeFileSync(pluginFile, text(files, `${slug}/${slug}.php`));

    const lint = spawnSync('php', ['-l', pluginFile], { encoding: 'utf8' });
    expect(lint.stderr + lint.stdout).toContain('No syntax errors');

    const harness = path.join(dir, 'harness.php');
    fs.writeFileSync(harness, `<?php
define('ABSPATH', '/tmp/');
$GLOBALS['captured'] = array();
$GLOBALS['shortcodes'] = array();
$GLOBALS['body'] = '{"name":"<script>alert(1)</script>","n":{"deep":"<img src=x onerror=1>"}}';
function wp_remote_get($u, $a) { $GLOBALS['captured'] = array('method' => 'GET', 'url' => $u, 'args' => $a); return array('code' => 200, 'body' => $GLOBALS['body']); }
function wp_remote_post($u, $a) { $GLOBALS['captured'] = array('method' => 'POST', 'url' => $u, 'args' => $a); return array('code' => 200, 'body' => $GLOBALS['body']); }
function is_wp_error($r) { return false; }
function wp_remote_retrieve_response_code($r) { return $r['code']; }
function wp_remote_retrieve_body($r) { return $r['body']; }
function esc_html($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function wp_json_encode($d, $f = 0) { return json_encode($d, $f); }
function add_shortcode($tag, $cb) { $GLOBALS['shortcodes'][$tag] = $cb; }
require $argv[1];
$out = array('captured' => null, 'output' => array());
foreach ($GLOBALS['shortcodes'] as $tag => $cb) { $out['output'][$tag] = call_user_func($cb); }
$out['captured'] = $GLOBALS['captured'];
echo json_encode($out);
`);
    const run = JSON.parse(execFileSync('php', [harness, pluginFile], { encoding: 'utf8' }));
    // 1) nothing in the payloads was executed
    expect(fs.existsSync(MARKER)).toBe(false);
    // 2) every hostile value reached the request exactly as typed
    expect(run.captured.url).toBe(HOSTILE.apiUrl);
    expect(run.captured.args.headers.Authorization).toBe(`Bearer ${HOSTILE.apiKey}`);
    expect(run.captured.args.headers[`X-${PHP_PAYLOAD}`]).toBe(`v\\${PHP_PAYLOAD}\n?>`);
    expect(run.captured.args.headers['X-Plain']).toBe('ok');
    // 3) the output shown on a page is escaped
    const shown = Object.values(run.output).join('\n');
    expect(shown).not.toContain('<script>');
    expect(shown).not.toContain('<img');
    expect(shown).toContain('&lt;script&gt;');
    // 4) both shortcodes exist
    expect(Object.keys(run.output).length).toBe(2);
  });

  it.skipIf(!phpAvailable)('uses wp_remote_post for POST', () => {
    const { files, slug } = generatePlugin({ ...NORMAL, platform: 'wordpress', apiMethod: 'POST', visualizeData: false }, null);
    expect(text(files, `${slug}/${slug}.php`)).toContain('wp_remote_post(');
  });

  it('never calls anything but the expected WordPress/PHP functions', async () => {
    const { Engine } = await import('php-parser');
    const { files, slug } = generatePlugin(HOSTILE, null);
    const ast = new Engine({ parser: { php8: true, extractDoc: true }, ast: { withPositions: false } }).parseCode(text(files, `${slug}/${slug}.php`), 'plugin.php');
    const calls = new Set<string>();
    const declared = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as { kind?: string; name?: string | { name?: string }; what?: { kind?: string; name?: string }; [k: string]: unknown };
      if (n.kind === 'call' && n.what?.kind === 'name' && n.what.name) calls.add(n.what.name);
      if (n.kind === 'function') declared.add(typeof n.name === 'string' ? n.name : (n.name?.name ?? ''));
      for (const value of Object.values(n)) {
        if (Array.isArray(value)) value.forEach(walk);
        else walk(value);
      }
    };
    walk(ast);
    // the plugin may call the WordPress/PHP functions below and the functions it declares itself, nothing else
    const allowed = new Set(['defined', 'wp_remote_get', 'is_wp_error', 'wp_remote_retrieve_response_code', 'wp_remote_retrieve_body', 'json_decode', 'esc_html', 'wp_json_encode', 'add_shortcode', 'is_array', 'is_scalar']);
    expect(declared.size).toBe(3);                                                  // fetch, shortcode, visualize
    for (const name of calls) expect(allowed.has(name) || declared.has(name), `unexpected call: ${name}`).toBe(true);
    for (const dangerous of ['system', 'exec', 'shell_exec', 'passthru', 'popen', 'proc_open', 'eval', 'file_put_contents', 'file_get_contents', 'unlink', 'include', 'require']) {
      expect([...calls]).not.toContain(dangerous);
    }
  });
});

/** Runs a generated popup.js in an isolated context with a fake document and fetch. */
async function runPopup(source: string, response: unknown) {
  const fetched: Array<{ url: string; options: { method: string; headers: Record<string, string> } }> = [];
  const innerHtmlWrites: string[] = [];
  const makeElement = (tag = 'div') => {
    const el: Record<string, unknown> = { tag, children: [] as unknown[], textContent: '', className: '' };
    Object.defineProperty(el, 'innerHTML', { set: (v: string) => innerHtmlWrites.push(v), get: () => '' });
    el.append = (...c: unknown[]) => (el.children as unknown[]).push(...c);
    el.appendChild = (c: unknown) => (el.children as unknown[]).push(c);
    el.replaceChildren = (...c: unknown[]) => { el.children = c; };
    return el;
  };
  const byId: Record<string, Record<string, unknown>> = { result: makeElement(), visualization: makeElement() };
  let ready: (() => Promise<void>) | undefined;
  const context = {
    document: { getElementById: (id: string) => byId[id], createElement: (t: string) => makeElement(t), createTextNode: (t: string) => ({ text: t }), addEventListener: (_: string, fn: () => Promise<void>) => { ready = fn; } },
    fetch: async (url: string, options: { method: string; headers: Record<string, string> }) => { fetched.push({ url, options }); return { ok: true, status: 200, json: async () => response }; },
    JSON, Object, Error, String,
  };
  vm.runInNewContext(source, context, { timeout: 2000 });
  await ready?.();
  return { fetched, innerHtmlWrites, byId };
}

describe.each(['chrome', 'firefox'] as const)('%s extension', (platform) => {
  const gen = (config: PluginRequest, logo: Uint8Array | null = null) => generatePlugin({ ...config, platform }, logo);

  it('has a valid manifest', () => {
    const { files, slug } = gen(NORMAL, png);
    const manifest = JSON.parse(text(files, 'manifest.json'));
    expect(manifest.name).toBe('My API Viewer');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description.length).toBeLessThanOrEqual(132);
    expect(manifest.icons).toEqual({ '128': 'icon.png' });
    const patterns: string[] = platform === 'chrome' ? manifest.host_permissions : manifest.permissions;
    expect(patterns).toEqual(['https://api.example.com/*']);                       // a real match pattern, with a path
    expect(patterns[0]).toMatch(/^https?:\/\/[^/*]+\/\*$/);
    if (platform === 'chrome') {
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.permissions).toBeUndefined();                                 // no unneeded permissions
      expect(manifest.action.default_popup).toBe('popup.html');
    } else {
      expect(manifest.manifest_version).toBe(2);
      expect(manifest.browser_action.default_popup).toBe('popup.html');
      expect(manifest.browser_specific_settings.gecko.id).toBe(`${slug}@api-plugin-generator.local`);
      expect(manifest.browser_specific_settings.gecko.id).toMatch(/^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$/);
    }
    expect(files['icon.png']).toBeInstanceOf(Uint8Array);
  });

  it('keeps the host pattern valid for URLs with ports, paths and no path', () => {
    expect(hostPattern('https://api.example.com')).toBe('https://api.example.com/*');
    expect(hostPattern('http://example.com:8080/a/b?c=d')).toBe('http://example.com:8080/*');
  });

  it('produces a popup that is syntactically valid and never uses innerHTML or eval', () => {
    const { files } = gen(HOSTILE);
    const js = text(files, 'popup.js');
    expect(() => acorn.parse(js, { ecmaVersion: 2022 })).not.toThrow();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it('sends exactly what was configured, even with hostile values, and renders remote data as text', async () => {
    const { files } = gen(HOSTILE);
    const remote = { name: '<img src=x onerror=alert(1)>', nested: { a: '<script>1</script>' } };
    const { fetched, innerHtmlWrites, byId } = await runPopup(text(files, 'popup.js'), remote);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe(HOSTILE.apiUrl);
    expect(fetched[0].options.method).toBe('GET');
    expect(fetched[0].options.headers.Authorization).toBe(`Bearer ${HOSTILE.apiKey}`);
    expect(fetched[0].options.headers[`X-${PHP_PAYLOAD}`]).toBe(`v\\${PHP_PAYLOAD}\n?>`);
    expect(innerHtmlWrites).toEqual([]);                                                // remote data never goes through innerHTML
    const pre = (byId.result.children as Array<{ textContent: string }>)[0];
    expect(pre.textContent).toContain('<img src=x onerror=alert(1)>');                  // shown literally, as text
  });

  it('escapes the plugin name in the popup page', () => {
    const { files } = gen({ ...NORMAL, pluginName: '<img src=x onerror=alert(1)> & Co' });
    const html = text(files, 'popup.html');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; Co');
  });

  it('omits the visualization when it is not requested', () => {
    const { files } = gen({ ...NORMAL, visualizeData: false });
    expect(text(files, 'popup.html')).not.toContain('id="visualization"');
    expect(text(files, 'popup.js')).toContain('const VISUALIZE = false;');
  });

  it('warns that the key is stored in plain text', () => {
    expect(text(gen(NORMAL).files, 'README.txt')).toMatch(/plain text/i);
    expect(text(gen({ ...NORMAL, apiKey: '', headers: {} }).files, 'README.txt')).toMatch(/No API key/);
  });
});

describe('zip', () => {
  it('round-trips every platform', () => {
    for (const platform of ['wordpress', 'chrome', 'firefox'] as const) {
      const { files } = generatePlugin({ ...NORMAL, platform }, png);
      const unzipped = unzipSync(createZip(files));
      expect(Object.keys(unzipped).sort()).toEqual(Object.keys(files).sort());
      for (const [name, content] of Object.entries(files)) {
        expect(typeof content === 'string' ? strFromU8(unzipped[name]) : Array.from(unzipped[name])).toEqual(typeof content === 'string' ? content : Array.from(content));
      }
    }
  });
  it.each(['../evil.txt', '/etc/passwd', 'a/../../b', 'a\\b', 'a\u0000b'])('refuses the unsafe path %j', (p) => {
    expect(() => createZip({ [p]: 'x' })).toThrow(/Unsafe path/);
  });
});
