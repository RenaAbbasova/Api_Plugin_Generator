import { buildRequestHeaders } from '@/lib/headers';
import { phpCommentText, phpString } from '@/lib/escape';
import { identifier, slugify } from '@/lib/slug';
import type { PluginRequest } from '@/lib/schema';
import type { GeneratedFiles } from '@/lib/generators/types';

/** A WordPress plugin with a shortcode that shows the API data. Every value is escaped as a PHP string. */
export function generateWordPress(config: PluginRequest, logo: Uint8Array | null): { slug: string; files: GeneratedFiles } {
  const slug = slugify(config.pluginName);
  const fn = identifier(config.pluginName);
  const headerLines = Object.entries(buildRequestHeaders(config))
    .map(([name, value]) => `\t\t\t${phpString(name)} => ${phpString(value)},`)
    .join('\n');
  const request = config.apiMethod === 'POST' ? 'wp_remote_post' : 'wp_remote_get';

  const visualize = config.visualizeData
    ? `
/**
 * Shows the API data as a list. Every value is escaped before it is printed.
 */
function ${fn}_visualize_shortcode() {
	$data = ${fn}_fetch_data();
	if ( ! is_array( $data ) ) {
		return '<p>Unable to visualize the data.</p>';
	}
	$output = '<div class="api-data-visualization"><h2>API data</h2>';
	foreach ( $data as $key => $value ) {
		$text = is_scalar( $value ) ? (string) $value : wp_json_encode( $value );
		$output .= '<div class="data-item"><strong>' . esc_html( (string) $key ) . ':</strong> ' . esc_html( $text ) . '</div>';
	}
	return $output . '</div>';
}
add_shortcode( ${phpString(`${fn}_visualize`)}, ${phpString(`${fn}_visualize_shortcode`)} );
`
    : '';

  const source = `<?php
/**
 * Plugin Name: ${phpCommentText(config.pluginName)}
 * Description: ${phpCommentText(config.description)}
 * Version: 1.0.0
 * Author: API Plugin Generator
 * License: GPL-2.0-or-later
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Fetches the data from the API. Returns null when the request fails.
 */
function ${fn}_fetch_data() {
	$response = ${request}(
		${phpString(config.apiUrl)},
		array(
			'timeout' => 15,
			'headers' => array(
${headerLines}
			),
		)
	);
	if ( is_wp_error( $response ) ) {
		return null;
	}
	$code = (int) wp_remote_retrieve_response_code( $response );
	if ( $code < 200 || $code >= 300 ) {
		return null;
	}
	return json_decode( wp_remote_retrieve_body( $response ), true );
}

/**
 * Shortcode: shows the API data as formatted JSON. Output is escaped.
 */
function ${fn}_shortcode() {
	$data = ${fn}_fetch_data();
	if ( null === $data ) {
		return '<p>Unable to fetch the data.</p>';
	}
	return '<div class="api-data"><pre>' . esc_html( wp_json_encode( $data, JSON_PRETTY_PRINT ) ) . '</pre></div>';
}
add_shortcode( ${phpString(fn)}, ${phpString(`${fn}_shortcode`)} );
${visualize}`;

  const files: GeneratedFiles = {
    [`${slug}/${slug}.php`]: source,
    [`${slug}/README.txt`]: readme(slug, fn, config),
  };
  if (logo) files[`${slug}/assets/icon-256x256.png`] = logo;
  return { slug, files };
}

function readme(slug: string, fn: string, config: PluginRequest): string {
  return [
    `${config.pluginName}`,
    '',
    'Install: upload this zip in WordPress under Plugins > Add New > Upload Plugin, then activate it.',
    `Use: add the shortcode [${fn}] to a page or post${config.visualizeData ? ` (or [${fn}_visualize] for a list)` : ''}.`,
    '',
    config.apiKey ? 'WARNING: the API key is stored in plain text inside the plugin file. Do not share or publish this plugin.' : 'No API key is included.',
    `Folder: ${slug}/`,
    '',
  ].join('\n');
}
