#!/usr/bin/env node

import path from 'node:path';
import { materializeDeployLayout } from './project-bootstrap.mjs';

const isGlobalInstall = process.env.npm_config_global === 'true';
const installRoot = path.resolve(process.env.INIT_CWD || process.cwd());
const materializedLayout = isGlobalInstall
  ? {
      targetRoot: installRoot,
      packageVersion: null,
      upgradedFrom: null,
      copied: [],
      updated: [],
      removed: []
    }
  : materializeDeployLayout(installRoot);
const changedFileCount = materializedLayout.copied.length
  + materializedLayout.updated.length
  + materializedLayout.removed.length;

const lines = [
  '',
  'freertc installed.',
  ...(materializedLayout.upgradedFrom
    ? [`Updated deploy layout in ${materializedLayout.targetRoot} from FreeRTC ${materializedLayout.upgradedFrom} to ${materializedLayout.packageVersion} (${changedFileCount} files changed).`]
    : materializedLayout.copied.length > 0
      ? [`Materialized deploy layout in ${materializedLayout.targetRoot} (${materializedLayout.copied.length} files).`]
    : []),
  'Run commands from the project directory where you want the worker files created.',
  '',
  'Quick start:',
  isGlobalInstall ? '  1) freertc' : '  1) npx freertc',
  isGlobalInstall ? '  2) freertc deploy' : '  2) npx freertc deploy',
  '',
  'Need full control? Use:',
  isGlobalInstall ? '  freertc wizard' : '  npx freertc wizard',
  ''
];

console.log(lines.join('\n'));
