import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'transport',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
