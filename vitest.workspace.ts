import { fileURLToPath } from 'node:url';

const resolve = {
  alias: {
    '@orca-agent-deck/core': fileURLToPath(
      new URL('./packages/core/src/index.ts', import.meta.url),
    ),
    '@orca-agent-deck/adapter-cli': fileURLToPath(
      new URL('./packages/adapter-cli/src/index.ts', import.meta.url),
    ),
    '@orca-agent-deck/adapter-bridge': fileURLToPath(
      new URL('./packages/adapter-bridge/src/index.ts', import.meta.url),
    ),
  },
};

export default [
  { resolve, test: { name: 'unit', include: ['packages/**/*.test.ts', 'scripts/*.test.ts'] } },
  { resolve, test: { name: 'contract', include: ['test/contract/**/*.test.ts'] } },
  { resolve, test: { name: 'integration', include: ['test/integration/**/*.test.ts'] } },
];
