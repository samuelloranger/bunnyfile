import type { QueryClient } from '@tanstack/react-query';
import { createRouter as createTanstackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function createRouter({ queryClient }: { queryClient: QueryClient }) {
  return createTanstackRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultViewTransition: {
      types: ({ fromLocation, pathChanged, toLocation }) => {
        if (!pathChanged) return false;

        const fromIndex = fromLocation?.state.__TSR_index;
        const toIndex = toLocation.state.__TSR_index;
        return fromIndex != null && toIndex < fromIndex ? ['route-back'] : ['route-forward'];
      },
    },
  });
}
