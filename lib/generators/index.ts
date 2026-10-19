import type { PluginRequest } from '@/lib/schema';
import { generateExtension } from '@/lib/generators/extension';
import type { GeneratedFiles } from '@/lib/generators/types';
import { generateWordPress } from '@/lib/generators/wordpress';

export interface GeneratedPlugin {
  slug: string;
  files: GeneratedFiles;
}

/** Builds the files of a plugin from an already validated request. */
export function generatePlugin(config: PluginRequest, logo: Uint8Array | null): GeneratedPlugin {
  switch (config.platform) {
    case 'wordpress':
      return generateWordPress(config, logo);
    case 'chrome':
      return generateExtension(config, logo, 'chrome');
    case 'firefox':
      return generateExtension(config, logo, 'firefox');
  }
}
