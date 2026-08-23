// Bundled fallback catalog data. The data itself lives in its original modules;
// this re-export gives the catalog layer a single import point.

import { PROVIDERS } from '../providers';
import { MCP_PRESETS } from '../mcpCatalog';
// Import from the pure data module, NOT tools/visionTool (which imports the
// store and would create a module cycle).
import { VISION_BACKENDS } from '../tools/visionBackends';

export const DEFAULT_PROVIDERS = PROVIDERS;
export const DEFAULT_VISION_BACKENDS = VISION_BACKENDS;
export const DEFAULT_MCP_PRESETS = MCP_PRESETS;
