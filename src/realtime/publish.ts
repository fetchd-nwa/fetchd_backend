import type { FastifyInstance } from 'fastify';
import type { ThreadPublisher } from './bus.js';
import type { RealtimeHub } from './server.js';

/**
 * The bus a publishing route holds (9.2.0; pass 3 item 5, ruled MB27 Q6). A route calls this
 * ONCE, at registration, and publishes through what it returns after its transaction commits
 * (`publishForThread(row, event)`, total: never awaited, wrapped or caught).
 *
 * It throws, at registration, on an app without `app.realtime` (`buildApp()` decorates it
 * before any route; a bare test app decorates a recording bus with `withTestBus`), and on a hub
 * with no `message.created` element builder: a route that publishes onto a hub that cannot
 * deliver what it publishes would be a production no-op, the `?? NOOP_LOG` shape (memory "prove
 * the alarm channel"). Never a silent default, never a failure at request time.
 */
export function threadPublisherFor(app: FastifyInstance): ThreadPublisher {
  const hub: RealtimeHub | undefined | null = app.hasDecorator('realtime')
    ? app.realtime
    : undefined;
  if (hub === undefined || hub === null) {
    throw new Error(
      'realtime: a publishing route was registered on an app without app.realtime. buildApp() ' +
        'decorates it before any route (decorateRealtime); a bare test app uses withTestBus(app).',
    );
  }
  if (!hub.buildsMessageFrames) {
    throw new Error(
      'realtime: a publishing route was registered on a hub with no message element builder, so ' +
        'its message.created would reach no socket. Wire messageElement where app.realtime is ' +
        'decorated.',
    );
  }
  return hub.bus;
}
