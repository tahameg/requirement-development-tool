import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts'], coverage: {
  provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/shared/types/config.ts', 'src/shared/types/workspace.ts'],
  thresholds: {
    'src/shared/utils/idUtils.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
    'src/main/services/idGenerator.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
    'src/shared/types/schema.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
    'src/main/services/validation.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  },
} } });
