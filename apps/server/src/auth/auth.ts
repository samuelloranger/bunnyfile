import { type Auth, getAuth, retryProviderIfMissing } from './factory';

export type { Auth };

/**
 * Stable handle to the current better-auth instance. SSO settings changes swap
 * the instance behind it (see ./factory.ts), so importers keep using `auth`
 * unchanged and always reach the latest configuration.
 */
export const auth: Auth = new Proxy({} as Auth, {
  get(_target, prop) {
    if (prop === 'handler') {
      return async (request: Request) => {
        await retryProviderIfMissing();
        return getAuth().handler(request);
      };
    }
    return Reflect.get(getAuth(), prop);
  },
});
