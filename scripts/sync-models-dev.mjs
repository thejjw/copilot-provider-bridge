#!/usr/bin/env node

// CLI script to compare and audit copilot-provider-bridge's bundled providers against https://models.dev
// Usage:
//   node scripts/sync-models-dev.mjs [--provider <id>] [--json] [--snippets]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Bundle pure modules in-memory to execute ESM directly without build artifacts
const bundled = await esbuild.build({
  entryPoints: [path.join(projectRoot, 'src', 'catalog', 'modelsDevSync.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  target: 'node18',
});

const syncModuleCode = Buffer.from(bundled.outputFiles[0].text).toString('base64');
const syncModuleUrl = `data:text/javascript;base64,${syncModuleCode}`;
const {
  fetchModelsDevApi,
  compareProviderModels,
  KNOWN_MODELS_DEV_MAPPINGS,
} = await import(syncModuleUrl);

// Also bundle providers.ts to get PROVIDERS array
const bundledProviders = await esbuild.build({
  entryPoints: [path.join(projectRoot, 'src', 'providers.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  target: 'node18',
});
const provCode = Buffer.from(bundledProviders.outputFiles[0].text).toString('base64');
const provUrl = `data:text/javascript;base64,${provCode}`;
const { PROVIDERS } = await import(provUrl);
const args = process.argv.slice(2);
const providerFilter = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : undefined;
const outputJson = args.includes('--json');
const outputSnippets = args.includes('--snippets');

async function main() {
  if (!outputJson) {
    console.log('Fetching live catalog from https://models.dev/api.json...');
  }

  let apiData;
  try {
    apiData = await fetchModelsDevApi();
  } catch (err) {
    console.error('Error fetching models.dev data:', err?.message || err);
    process.exit(1);
  }

  const reports = [];

  for (const mapping of KNOWN_MODELS_DEV_MAPPINGS) {
    if (providerFilter && mapping.providerId !== providerFilter && mapping.modelsDevSlug !== providerFilter) {
      continue;
    }

    const providerData = apiData[mapping.modelsDevSlug];
    if (!providerData) {
      if (!outputJson) {
        console.warn(`[WARN] Slug "${mapping.modelsDevSlug}" not found in models.dev api.json`);
      }
      continue;
    }

    const existingProvider = PROVIDERS.find((p) => p.id === mapping.providerId);
    const existingModels = existingProvider ? existingProvider.models : [];

    const report = compareProviderModels(
      existingModels,
      providerData.models || {},
      {
        providerId: mapping.providerId,
        modelsDevSlug: mapping.modelsDevSlug,
        modelIdPrefix: mapping.modelIdPrefix,
        modelIdRegex: mapping.modelIdRegex,
      }
    );
    report.providerName = existingProvider ? existingProvider.name : providerData.name;
    reports.push(report);
  }

  if (outputJson) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  console.log('\n============================================================');
  console.log('   Copilot Provider Bridge <-> models.dev Audit Report');
  console.log('============================================================\n');

  let totalNew = 0;
  let totalModified = 0;
  let totalIdentical = 0;

  for (const rep of reports) {
    totalNew += rep.newModels.length;
    totalModified += rep.modifiedModels.length;
    totalIdentical += rep.identicalModels.length;

    console.log(`Provider: ${rep.providerName} (id: ${rep.providerId}) [models.dev: ${rep.modelsDevSlug}]`);
    console.log(`  Identical: ${rep.identicalModels.length}, Modified: ${rep.modifiedModels.length}, New: ${rep.newModels.length}`);

    if (rep.modifiedModels.length > 0) {
      console.log('  Modified Models:');
      for (const mod of rep.modifiedModels) {
        console.log(`    - ${mod.modelId}:`);
        for (const ch of mod.changes || []) {
          console.log(`        ${ch.field}: ${JSON.stringify(ch.oldValue)} -> ${JSON.stringify(ch.newValue)}`);
        }
      }
    }

    if (rep.newModels.length > 0) {
      console.log('  New Models:');
      for (const nm of rep.newModels) {
        const costStr = nm.cost?.input !== undefined ? ` ($${nm.cost.input}/$${nm.cost.output} per 1M)` : '';
        console.log(`    + ${nm.modelId}: ctx=${nm.suggested.contextWindow}, out=${nm.suggested.maxOutputTokens}, vision=${nm.suggested.vision}${costStr}`);
      }
    }

    if (rep.unmatchedExistingModelIds.length > 0) {
      console.log(`  Not in models.dev (${rep.unmatchedExistingModelIds.length}): ${rep.unmatchedExistingModelIds.join(', ')}`);
    }

    if (outputSnippets && rep.newModels.length > 0) {
      console.log('\n  --- Suggested TypeScript Snippet for src/providers.ts ---');
      for (const nm of rep.newModels) {
        console.log(`      {`);
        console.log(`        id: '${nm.suggested.id}',`);
        console.log(`        name: '${nm.suggested.name}',`);
        console.log(`        toolCalling: ${nm.suggested.toolCalling},`);
        console.log(`        vision: ${nm.suggested.vision},`);
        console.log(`        contextWindow: ${nm.suggested.contextWindow},`);
        console.log(`        maxInputTokens: ${nm.suggested.maxInputTokens},`);
        console.log(`        maxOutputTokens: ${nm.suggested.maxOutputTokens},`);
        if (nm.suggested.thinking) {
          console.log(`        thinking: true,`);
          console.log(`        supportsReasoningEffort: ['low', 'medium', 'high'],`);
        }
        console.log(`      },`);
      }
      console.log('  ---------------------------------------------------------\n');
    }

    console.log('');
  }

  console.log('------------------------------------------------------------');
  console.log(`Summary: ${totalNew} new models, ${totalModified} modified limits, ${totalIdentical} identical models.`);
  console.log('Run with --snippets to generate TypeScript definitions.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
