import { AlertTriangle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from './button';
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from './modal';

export type ConfirmDialogTone = 'neutral' | 'destructive';

export interface ConfirmDialogProps {
  trigger: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  onConfirm: () => unknown;
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'neutral',
  onConfirm,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleConfirm() {
    try {
      setPending(true);
      await onConfirm();
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>{trigger}</ModalTrigger>
      <ModalContent size="sm" showClose={false}>
        <ModalHeader>
          <div className="flex items-start gap-3">
            {tone === 'destructive' && (
              <span
                aria-hidden
                className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))]"
              >
                <AlertTriangle className="size-4" />
              </span>
            )}
            <div className="space-y-1">
              <ModalTitle>{title}</ModalTitle>
              {description && <ModalDescription>{description}</ModalDescription>}
            </div>
          </div>
        </ModalHeader>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="outline" disabled={pending}>
              {cancelLabel}
            </Button>
          </ModalClose>
          <Button
            variant={tone === 'destructive' ? 'destructive' : 'primary'}
            onClick={handleConfirm}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
