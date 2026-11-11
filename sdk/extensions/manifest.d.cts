import type { ExtensionManifest } from './contracts.js';

/** Validate raw UTF-8 bytes against the package rules for this checkout. Throws an error with a code. */
export function validateManifest(bytes: Uint8Array): ExtensionManifest;
