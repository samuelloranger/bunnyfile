import { queryOptions } from '@tanstack/react-query';
import { api } from './api';

/** Public login mode: which sign-in controls the login page shows. */
export const authConfigQuery = queryOptions({
  queryKey: ['auth-config'],
  queryFn: async () => {
    const { data, error } = await api.api['auth-config'].get();
    if (error) throw error;
    return data;
  },
  staleTime: 30_000,
});

const SSO_ERRORS: Record<string, string> = {
  signup_disabled:
    'No BunnyFile account matches that identity. Ask an admin to invite you with the same email address.',
  email_not_found:
    'Your identity provider did not return a verified email address, so you cannot sign in with it.',
  account_not_linked: 'That account could not be linked to an existing BunnyFile user.',
  unable_to_link_account: 'That account could not be linked to an existing BunnyFile user.',
  access_denied: 'Sign-in was cancelled or denied by the identity provider.',
};

export function ssoErrorMessage(code: string): string {
  return (
    SSO_ERRORS[code] ?? 'Single sign-on failed. Try again, or ask an admin to check the setup.'
  );
}
