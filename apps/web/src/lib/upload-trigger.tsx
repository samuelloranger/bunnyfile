import { createContext, type ReactNode, useCallback, useContext, useRef } from 'react';

type UploadTriggerContextValue = {
  registerOpener: (opener: () => void) => () => void;
  trigger: () => boolean;
};

const UploadTriggerContext = createContext<UploadTriggerContextValue | null>(null);

export function UploadTriggerProvider({ children }: { children: ReactNode }) {
  const openerRef = useRef<(() => void) | null>(null);

  const registerOpener = useCallback((opener: () => void) => {
    openerRef.current = opener;
    return () => {
      if (openerRef.current === opener) openerRef.current = null;
    };
  }, []);

  // Returns true if a registered opener handled it synchronously — caller can
  // then skip navigation. Synchronous invocation preserves the user-activation
  // gesture that browsers require for file pickers.
  const trigger = useCallback(() => {
    const opener = openerRef.current;
    if (!opener) return false;
    opener();
    return true;
  }, []);

  return (
    <UploadTriggerContext.Provider value={{ registerOpener, trigger }}>
      {children}
    </UploadTriggerContext.Provider>
  );
}

export function useUploadTrigger() {
  const ctx = useContext(UploadTriggerContext);
  if (!ctx) throw new Error('useUploadTrigger must be used within UploadTriggerProvider');
  return ctx;
}
