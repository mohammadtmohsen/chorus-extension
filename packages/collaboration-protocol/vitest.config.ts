import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'collaboration-protocol',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
