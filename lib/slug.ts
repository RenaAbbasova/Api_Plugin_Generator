const MAX = 40;

function plain(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** A file-system and URL safe name: letters, digits and hyphens only. */
export function slugify(name: string): string {
  const slug = plain(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX).replace(/-+$/g, '');
  return slug || 'plugin';
}

/** A valid PHP / JavaScript identifier: letters, digits and underscores, never starting with a digit. */
export function identifier(name: string): string {
  const id = plain(name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX).replace(/_+$/g, '');
  if (!id) return 'plugin';
  return /^[0-9]/.test(id) ? `plugin_${id}` : id;
}
