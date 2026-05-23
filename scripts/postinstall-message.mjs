#!/usr/bin/env node

const isGlobalInstall = process.env.npm_config_global === 'true';

const lines = [
  '',
  'freertc installed.',
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
