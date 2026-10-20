/** Keep the site's document shortcuts from cancelling a modal's native Escape. */
export function isolateDialogEscape(dialog: HTMLDialogElement): () => void {
  const keydown = (event: KeyboardEvent) => {
    if (dialog.open && event.key === 'Escape' && !event.isComposing) {
      // Keep native cancellation (including nested dialogs and select popups),
      // and let controls inside the dialog handle the key before it reaches us.
      event.stopPropagation();
    }
  };
  dialog.addEventListener('keydown', keydown);
  return () => dialog.removeEventListener('keydown', keydown);
}
