/**
 * The one Supabase admin-client module (E40; design §2.1:2115-2117), born in
 * P02 as a factory: `makeAdminClient(url, serviceRoleKey)`. `npm run
 * staff:provision` builds it from its own three variables; the server will
 * build it from `env` when its first admin caller lands (MIG-U18's invite) —
 * no server code calls it at 2.0.0, so `env.ts` gains no service-role key yet.
 *
 * It imports nothing that loads `src/env.ts` (the script's boundary), and it
 * speaks GoTrue's admin REST API with `fetch` — no new dependency:
 *
 *   GET  /auth/v1/admin/users?page=&per_page=   list (paged)
 *   POST /auth/v1/admin/users                   create
 *   PUT  /auth/v1/admin/users/:id               update (app_metadata, ban)
 *   POST /auth/v1/admin/generate_link           a recovery (set-password) link
 *
 * `app_metadata` is merged by GoTrue key by key, and a key sent as `null` is
 * removed — which is how `--expire` takes `app_role` away. What no test here
 * proves: these request and response shapes against a real GoTrue (the tests
 * use a fake client of the same interface).
 */

export interface AdminUser {
  id: string;
  /** `null` for a phone-only user. */
  email: string | null;
  created_at: string;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  /** Server-written: only the admin API sets it. `app_role` lives here.
   *  `null` for a user whose `raw_app_meta_data` is NULL: GoTrue sends a nil
   *  map as JSON `null` (adversary r2 N3). */
  app_metadata: Record<string, unknown> | null;
  identities: Array<{ provider: string }>;
  banned_until?: string | null;
}

export interface AdminClient {
  /** One page of the listing, 1-based. An EMPTY page is the end: GoTrue may
   *  cap `per_page` below what was asked, so a short page is not the last. */
  listUsers(page: number): Promise<AdminUser[]>;
  createUser(args: {
    email: string;
    email_confirm: true;
    app_metadata: { app_role: string };
  }): Promise<AdminUser>;
  updateUserById(
    id: string,
    args: { app_metadata?: Record<string, unknown>; ban_duration?: string },
  ): Promise<AdminUser>;
  generateRecoveryLink(email: string, redirectTo: string): Promise<{ action_link: string }>;
}

const PAGE_SIZE = 200;

export function makeAdminClient(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): AdminClient {
  const base = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      // Never follow a redirect (DECISIONS 82(a)): fetch drops `Authorization`
      // on a cross-origin hop but keeps `apikey`, so following one would hand
      // the service-role key to wherever the host points — in cleartext if
      // that is http://. GoTrue's admin API does not redirect; a call that
      // meets one fails instead.
      redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      // GoTrue's error body names the problem; it never echoes the key.
      throw new Error(`Supabase admin ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  return {
    async listUsers(page) {
      const result = await call<{ users?: AdminUser[] }>(
        'GET',
        `/admin/users?page=${page}&per_page=${PAGE_SIZE}`,
      );
      return result.users ?? [];
    },
    createUser(args) {
      return call<AdminUser>('POST', '/admin/users', args);
    },
    updateUserById(id, args) {
      return call<AdminUser>('PUT', `/admin/users/${encodeURIComponent(id)}`, args);
    },
    async generateRecoveryLink(email, redirectTo) {
      const result = await call<{ action_link?: string; properties?: { action_link?: string } }>(
        'POST',
        '/admin/generate_link',
        { type: 'recovery', email, redirect_to: redirectTo },
      );
      const link = result.action_link ?? result.properties?.action_link;
      if (typeof link !== 'string' || link.length === 0) {
        throw new Error(`Supabase admin generate_link returned no action_link for ${email}`);
      }
      return { action_link: link };
    },
  };
}
