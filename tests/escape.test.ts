import { describe, expect, it } from 'vitest';
import { htmlEscape, jsString, phpCommentText, phpString } from '@/lib/escape';
import { identifier, slugify } from '@/lib/slug';

describe('escaping', () => {
  it('phpString escapes quotes and backslashes and strips NUL', () => {
    expect(phpString("a'b")).toBe("'a\\'b'");
    expect(phpString('a\\b')).toBe("'a\\\\b'");
    expect(phpString("x\u0000y")).toBe("'xy'");
    expect(phpString("'); system('id'); //")).toBe("'\\'); system(\\'id\\'); //'");
  });
  it('phpCommentText cannot close a comment or add a line', () => {
    expect(phpCommentText('a */ system("x"); /* b')).not.toContain('*/');
    expect(phpCommentText('a\nb\r\nc')).toBe('a b c');
  });
  it('jsString is safe inside JSON and inline scripts', () => {
    const out = jsString('</script><img src=x onerror=alert(1)>\u2028"\\');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('\u2028');
    expect(JSON.parse(out)).toBe('</script><img src=x onerror=alert(1)>\u2028"\\');
  });
  it('htmlEscape handles the five characters', () => {
    expect(htmlEscape(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('names', () => {
  it('slugify never returns path characters', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('My Plugin (v2)!')).toBe('my-plugin-v2');
    expect(slugify('Café Ñandú')).toBe('cafe-nandu');
    expect(slugify('***')).toBe('plugin');
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(40);
  });
  it('identifier is always a valid PHP / JS identifier', () => {
    for (const name of ['My Plugin', 'my-plugin', '3d viewer', 'a.b.c', '***', "x'); system('id'); //"]) {
      expect(identifier(name)).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
    expect(identifier('3d viewer')).toBe('plugin_3d_viewer');
  });
});
