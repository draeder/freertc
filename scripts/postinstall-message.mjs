#!/usr/bin/env node

const isGlobalInstall = process.env.npm_config_global === 'true';

const lines = [
  '',
  'freertc installed.',
  '',
  'Quick start:',
  isGlobalInstall ? '  1) freertc' : '  1) npx freertc',
  '  2) npx freertc deploy',
  '',
  'Need full control? Use:',
  '  npx freertc wizard',
  ''
];

console.log(lines.join('\n'));
