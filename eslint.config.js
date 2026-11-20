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
  {
    // O-POOLFIX (fix 2; r2 Opus L2 = Fable N1): the app opens no transaction on the pool-bound `db`. drizzle's
    // `db.transaction` sends BEGIN before its try/finally { release() }, so a BEGIN that meets a lost connection
    // keeps its pool slot for good, and ten wedge every route (r1 H1). Transactions open through `withActor` /
    // `withTransaction` (`src/db/tx.ts`). Tests keep their own `db.transaction`.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='db'][callee.property.name='transaction']",
          message:
            'No db.transaction in src/: open transactions through withActor / withTransaction (src/db/tx.ts), which release the client on every path, BEGIN included (O-POOLFIX).',
        },
      ],
    },
  },
  prettier,
);
