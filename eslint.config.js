import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/db/schema/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 9.2.0 (P45; design §3 rule 2, M5): one publish choke point. Only `src/realtime/bus.ts`
    // calls `.publish(`, through `channelsForThread(row)`, so the channels an event reaches come
    // from the committed thread row and never from a call site. Anything else publishes through
    // `app.realtime.bus.publishForThread(...)`.
    ignores: ['src/realtime/bus.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'publish',
          message:
            'Only src/realtime/bus.ts publishes (the one choke point, channelsForThread): use app.realtime.bus.publishForThread(row, event).',
        },
      ],
    },
  },
  prettier,
);
