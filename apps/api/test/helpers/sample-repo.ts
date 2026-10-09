import type { ZipEntrySpec } from './zip.js';

const PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

export const SECRET_MARKERS = ['sk-test-not-a-real-key', 'hunter2', 'PRIVATE KEY', 'dummy-ca-body'];

export function sampleRepoEntries(): ZipEntrySpec[] {
  return [
    {
      name: 'package.json',
      data: '{ "name": "shop-api", "dependencies": { "express": "^5.0.0" } }\n',
    },
    { name: 'README.md', data: '# Shop API\n\nOrders and payments.\n' },
    { name: 'Dockerfile', data: 'FROM node:22\nCOPY . .\nCMD ["node", "dist/server.js"]\n' },
    { name: 'src/server.ts', data: "import { app } from './app.js';\napp.listen(3000);\n" },
    {
      name: 'src/app.ts',
      data: "export const app = express();\napp.get('/orders', listOrders);\n",
    },
    { name: 'src/orders/list.ts', data: 'export async function listOrders() { return []; }\n' },
    { name: 'src/payments/charge.py', data: 'def charge(order):\n    return order.total\r\n' },
    {
      name: 'docs/architecture.md',
      data: `# Architecture\n\n${'Orders flow through payments. '.repeat(80)}\n`,
    },
    { name: 'deploy/helm/values.yaml', data: 'replicas: 2\n' },
    { name: 'src/ünïcode/naïve café.ts', data: 'export const greeting = "hello";\n' },

    { name: '.env', data: 'STRIPE_KEY=sk-test-not-a-real-key\n' },
    { name: 'apps/admin/.ENV.local', data: 'PASSWORD=hunter2\n' },
    { name: 'config/Secrets.YML', data: 'token: hunter2\n' },
    { name: 'deploy/ca.pem', data: 'dummy-ca-body' },
    { name: 'src/payments/legacy-key.ts', data: `export const key = \`${PRIVATE_KEY}\`;\n` },

    { name: 'node_modules/express/index.js', data: 'module.exports = {};\n' },
    { name: 'src/vendor/node_modules/deep/index.js', data: 'module.exports = {};\n' },
    { name: 'dist/server.js', data: 'console.log("built");\n' },
    { name: 'package-lock.json', data: '{ "lockfileVersion": 3 }\n' },
    {
      name: 'public/logo.png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
    { name: 'src/generated/bundle.js', data: `${'var x=function(){return 1};'.repeat(80)}\n` },
    { name: 'src/payments/blob.ts', data: Buffer.from([0x63, 0x00, 0x64]) },
    { name: 'src/empty.ts', data: '' },
    { name: 'src/link.ts', data: '../.env', symlink: true },
  ];
}

export const SAMPLE_INDEXED_PATHS = [
  'Dockerfile',
  'README.md',
  'deploy/helm/values.yaml',
  'docs/architecture.md',
  'package.json',
  'src/app.ts',
  'src/orders/list.ts',
  'src/payments/charge.py',
  'src/server.ts',
  'src/ünïcode/naïve café.ts',
];

export const SAMPLE_SKIPPED: Record<string, string> = {
  '.env': 'secret',
  'apps/admin/.ENV.local': 'secret',
  'config/Secrets.YML': 'secret',
  'deploy/ca.pem': 'secret',
  'src/payments/legacy-key.ts': 'secret',
  'node_modules/express/index.js': 'ignored-directory',
  'src/vendor/node_modules/deep/index.js': 'ignored-directory',
  'dist/server.js': 'ignored-directory',
  'package-lock.json': 'lockfile',
  'public/logo.png': 'unsupported-type',
  'src/generated/bundle.js': 'minified',
  'src/payments/blob.ts': 'binary',
  'src/empty.ts': 'empty',
  'src/link.ts': 'symlink',
};
