import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, ShieldCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { pushNotification } from '~/lib/notifications';
import {
  type SsoSettings,
  type SsoSettingsInput,
  saveSsoSettings,
  ssoSettingsQuery,
} from '~/lib/sso-settings';

type Draft = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
  scopes: string;
  enabled: boolean;
  ssoOnly: boolean;
};

function toDraft(s: SsoSettings): Draft {
  return {
    issuer: s.issuer,
    clientId: s.clientId,
    clientSecret: '',
    label: s.label,
    scopes: s.scopes,
    enabled: s.enabled,
    ssoOnly: s.ssoOnly,
  };
}

/** Admin-only "Single sign-on" section of the settings page. */
export function SsoSettingsSection() {
  const settings = useQuery(ssoSettingsQuery);
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (settings.data) setDraft(toDraft(settings.data));
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (input: SsoSettingsInput) => saveSsoSettings(input),
    onSuccess: (saved) => {
      setError(null);
      qc.setQueryData(ssoSettingsQuery.queryKey, saved);
      qc.invalidateQueries({ queryKey: ['auth-config'] });
      pushNotification({ kind: 'success', title: 'Single sign-on settings saved' });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Could not save'),
  });

  if (settings.isLoading || !draft || !settings.data) {
    return (
      <Section>
        <p className="mt-4 text-sm text-[hsl(var(--muted-foreground))]">
          {settings.isError ? 'Could not load the SSO settings.' : 'Loading…'}
        </p>
      </Section>
    );
  }

  const current = settings.data;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setError(null);
    save.mutate({
      issuer: draft.issuer,
      clientId: draft.clientId,
      ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
      label: draft.label,
      scopes: draft.scopes,
      enabled: draft.enabled,
      ssoOnly: draft.ssoOnly,
    });
  }

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(current.callbackUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context): the URL is selectable text.
    }
  }

  return (
    <Section>
      <form
        onSubmit={onSubmit}
        className="mt-4 space-y-4 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-4"
      >
        <div className="space-y-1.5">
          <Label htmlFor="sso-callback">Callback URL</Label>
          <div className="flex gap-2">
            <Input id="sso-callback" readOnly value={current.callbackUrl} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={copied ? <Check /> : <Copy />}
              onClick={copyCallback}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Register this as the redirect URI of a confidential client at your identity provider,
            using client secret basic authentication.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sso-issuer">Issuer URL</Label>
          <Input
            id="sso-issuer"
            type="url"
            required
            value={draft.issuer}
            onChange={(e) => set('issuer', e.currentTarget.value)}
            placeholder="https://id.example.com"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sso-client-id">Client ID</Label>
            <Input
              id="sso-client-id"
              required
              autoComplete="off"
              value={draft.clientId}
              onChange={(e) => set('clientId', e.currentTarget.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-client-secret">
              Client secret
              {current.clientSecretSet && (
                <span className="ml-2 rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                  set
                </span>
              )}
            </Label>
            <Input
              id="sso-client-secret"
              type="password"
              autoComplete="new-password"
              leftIcon={<KeyRound />}
              required={!current.clientSecretSet}
              value={draft.clientSecret}
              onChange={(e) => set('clientSecret', e.currentTarget.value)}
              placeholder={
                current.clientSecretSet ? 'Leave blank to keep, or enter to replace' : ''
              }
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sso-label">Button label</Label>
            <Input
              id="sso-label"
              maxLength={40}
              value={draft.label}
              onChange={(e) => set('label', e.currentTarget.value)}
              placeholder="SSO"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-scopes">Scopes</Label>
            <Input
              id="sso-scopes"
              value={draft.scopes}
              onChange={(e) => set('scopes', e.currentTarget.value)}
              placeholder="openid email profile"
            />
          </div>
        </div>

        <div className="space-y-3 border-t border-[hsl(var(--border))] pt-4">
          <Toggle
            id="sso-enabled"
            checked={draft.enabled}
            onChange={(v) => {
              set('enabled', v);
              if (!v) set('ssoOnly', false);
            }}
            title="Enable SSO"
            description="Show the sign-in button next to the password form. Only existing users can sign in, matched by a verified email address."
          />
          <Toggle
            id="sso-only"
            checked={draft.ssoOnly}
            disabled={!draft.enabled}
            onChange={(v) => set('ssoOnly', v)}
            title="SSO only"
            description="Hide the password form and refuse password sign-in, sign-up and reset on the server. Requires that you have already signed in through SSO with your own account."
          />
          {current.forcePasswordLogin && (
            <p className="rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.1)] px-3 py-2 text-xs">
              BUNNYFILE_FORCE_PASSWORD_LOGIN is set: password login stays available regardless of
              these settings.
            </p>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] px-3 py-2 text-sm text-[hsl(var(--destructive))]"
          >
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" loading={save.isPending}>
            Save
          </Button>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Saving checks the provider's discovery document and applies immediately.
          </p>
        </div>
      </form>
    </Section>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-base font-medium">
        <ShieldCheck className="size-4 text-[hsl(var(--muted-foreground))]" />
        Single sign-on
      </h2>
      <p className="mt-0.5 text-sm text-[hsl(var(--muted-foreground))]">
        Let people sign in with your OpenID Connect provider (Authelia, Authentik, Keycloak and
        similar).
      </p>
      {children}
    </section>
  );
}

function Toggle({
  id,
  checked,
  disabled,
  onChange,
  title,
  description,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-1 size-4 shrink-0 accent-[hsl(var(--primary))]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <label htmlFor={id} className={disabled ? 'opacity-50' : undefined}>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-[hsl(var(--muted-foreground))]">{description}</span>
      </label>
    </div>
  );
}
