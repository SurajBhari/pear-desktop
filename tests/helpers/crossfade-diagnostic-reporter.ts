import { test } from '@playwright/test';
import {
  diagnosticCaseForTitle,
  sanitizeDiagnosticReport,
  unavailableDiagnostic,
} from './crossfade-diagnostics';

/** Reporter stdout survives CI removal of per-group attachment directories. */
export function installCrossfadeDiagnosticReporter() {
  test.afterEach(async ({ page }, info) => {
    const caseId = diagnosticCaseForTitle(info.title);
    if (!caseId) return;
    let result = unavailableDiagnostic(caseId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        // Browser entry is self-contained; the helper itself is bundled in the page.
        page.evaluate(
          () => (window as any).crossfadeFixture?.diagnostic?.finish() ?? null,
        ),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 100);
        }),
      ]);
      const clean = sanitizeDiagnosticReport(raw);
      if (clean?.case === caseId) result = clean;
    } catch {
      // Keep the original test failure. No raw errors or page data enter the sink.
    } finally {
      clearTimeout(timer);
    }
    try {
      console.log('PR90_MAC_AUDIO_DIAGNOSTIC_V1 ' + JSON.stringify(result));
    } catch {
      // Reporting must never replace the test's original exception.
    }
  });
}
