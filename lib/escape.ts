/**
 * Escaping helpers. Every value that comes from the user and ends up inside generated code
 * goes through one of these, according to the language it is written into.
 */

/** A PHP single-quoted string literal. Only `\` and `'` have special meaning inside one. */
export function phpString(value: string): string {
  return "'" + value.replace(/\u0000/g, '').replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** Text that is safe inside a PHP block comment: one line, and it cannot close the comment. */
export function phpCommentText(value: string): string {
  return value.replace(/[\r\n\u0000]+/g, ' ').replace(/\*\//g, '* /').trim();
}

/** A JavaScript string literal that is also safe inside an inline `<script>` and in JSON. */
export function jsString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Text that is safe as HTML content or as a double-quoted attribute value. */
export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
