import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'collaboration-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
