import type { Instrumentation } from 'next';

import { reportError } from '@/lib/observability';

/**
 * The server-error seam.
 *
 * `onRequestError` is Next's own hook and fires for every error the server
 * catches — a Server Component render, a Route Handler, a Server Action, the
 * proxy. That breadth is why it is the right place: the alternative is a
 * `try/catch` in every one of those, which is a list that goes out of date the
 * first time somebody adds a page.
 *
 * IT IS NOT `app/error.tsx`. That is a Client Component, so anything it logs
 * goes to the visitor's console and nowhere we can read — and by the time an
 * error reaches it Next has already replaced the message with a generic string
 * and kept only a `digest`. `error.tsx` shows the human a reference; this turns
 * that same reference into a line somebody can search for.
 *
 * `instrumentation.ts` lives in `src/` because this project has a `src/` folder
 * — beside `app`, never inside it.
 *
 * THE HEADERS ARE DELIBERATELY DROPPED. Next hands them over in full and they
 * carry the session cookie, which on Supabase is a live access token. See the
 * header of `observability.ts`: the path is logged, the headers never are.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  reportError(error, {
    source: 'request',
    // `request.path` includes the query string; `reportError` strips it.
    route: request.path,
    kind: context.routeType,
    digest:
      typeof error === 'object' && error !== null && 'digest' in error
        ? String((error as { digest?: unknown }).digest)
        : undefined,
    extra: {
      method: request.method,
      // The route FILE — `/orders/[id]` — which is what groups incidents
      // together, as opposed to `request.path`, which is one visitor's URL.
      routePath: context.routePath,
    },
  });
};
