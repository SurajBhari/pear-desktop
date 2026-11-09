/** Keep the site's document shortcuts from cancelling a modal's native Escape. */
export function isolateDialogEscape(dialog: HTMLDialogElement): () => void {
  const doc = dialog.ownerDocument;
  const keydown = (event: KeyboardEvent) => {
    if (dialog.open && event.key === 'Escape' && !event.isComposing) {
      // Keep native cancellation (including nested dialogs and select popups),
      // and let controls inside the dialog handle the key before it reaches us.
      event.stopPropagation();
    }
  };
  const outsideKeydown = (event: KeyboardEvent) => {
    if (
      dialog.open &&
      event.key === 'Escape' &&
      !event.isComposing &&
      doc.activeElement === doc.body &&
      (event.target === doc.body || event.target === doc)
    ) {
      // Replacing focused controls can leave focus on body while the modal is
      // still open. Keep that Escape from the site's document shortcuts too.
      // A shadow host can hide a focused foreign dialog, so leave every other
      // target alone rather than inferring ownership from composedPath().
      event.stopPropagation();
    }
  };
  dialog.addEventListener('keydown', keydown);
  doc.addEventListener('keydown', outsideKeydown, true);
  return () => {
    dialog.removeEventListener('keydown', keydown);
    doc.removeEventListener('keydown', outsideKeydown, true);
  };
}
