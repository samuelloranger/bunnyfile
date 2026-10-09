import { queryOptions } from '@tanstack/react-query';
import { api } from './api';

export type SsoSettings = {
  configured: boolean;
  issuer: string;
  clientId: string;
  clientSecretSet: boolean;
  label: string;
  scopes: string;
  enabled: boolean;
  ssoOnly: boolean;
  forcePasswordLogin: boolean;
  callbackUrl: string;
};

export type SsoSettingsInput = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  label: string;
  scopes: string;
  enabled: boolean;
  ssoOnly: boolean;
};

export function errorMessage(error: unknown, fallback: string): string {
  const value = (error as { value?: unknown } | null)?.value;
  if (value && typeof value === 'object' && 'error' in value) {
    const message = (value as { error?: unknown }).error;
    if (typeof message === 'string') return message;
  }
  return fallback;
}

export const ssoSettingsQuery = queryOptions({
  queryKey: ['sso-settings'],
  queryFn: async (): Promise<SsoSettings> => {
    const { data, error } = await api.api.settings.sso.get();
    if (error) throw new Error(errorMessage(error, 'Could not load SSO settings'));
    return data as SsoSettings;
  },
});

export async function saveSsoSettings(input: SsoSettingsInput): Promise<SsoSettings> {
  const { data, error } = await api.api.settings.sso.put(input);
  if (error) throw new Error(errorMessage(error, 'Could not save SSO settings'));
  return data as SsoSettings;
}
