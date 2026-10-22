# History navigation gestures

The Navigation plugin offers experimental horizontal swipe navigation and
Windows/Linux browser Back/Forward commands. Enable its experimental menu checkbox
to try both additions; they default to off pending physical-device acceptance.
The existing navigation arrows remain available. No operating-system gesture
settings are changed.

Horizontal pixel-wheel movement toward the start of a page requests Back;
movement toward its end requests Forward. Direction follows the scrolling events
provided by the operating system. A deliberate horizontal movement is required,
and further movement in that direction is suppressed until 600 ms of quiet.
After a wheel-requested history change reaches the exact expected adjacent entry,
an opposite stroke can start after more than 40 ms of quiet. Its tiny initial
movements are retained, but it still needs two opposite samples of at least 12
pixels each and the normal 180-pixel horizontal threshold. This lets a deliberate
Back/Forward reversal follow a long momentum tail without unlocking repeated
navigation in the original direction.

The handler leaves horizontal carousels alone, including their edges. It also
ignores modified scrolling, editable controls, sliders, the player bar, visible
dialogs, and regions with horizontal overscroll containment. Vertical or diagonal
scrolling cannot turn into history navigation halfway through a stream. A site's
cancellation of a wheel event takes priority. Stopping the plugin releases its
listeners and any pending transition.

The short reversal path requires the browser Navigation API to identify both
history entries. Its expected entry must arrive within 600 ms of the request;
that deadline is fixed even while scrolling continues. Unmatched history changes,
native commands, focus interruptions, and rejected or canceled wheel samples
discard reversal eligibility. A history entry change during an opposite stroke
also cancels it. Missing history information, no-op requests, and fragment history
changes retain the conservative 600 ms quiet-period behavior.

Protected focus boundaries include assigned slots and open shadow roots. Visible
overlays in open shadow roots are checked when a stream starts and before leaving
the page. Closed shadow internals cannot be inspected unless their host exposes
the relevant semantics.

## Platform limits

Electron 42.10.0 does not expose Safari's native two-finger history interaction.
This plugin recognizes scrolling at the application level. A DOM wheel event
cannot reliably distinguish a trackpad from a pixel-scrolling mouse, count
fingers, or identify native touch-release and momentum phases. Quiet-time grouping
and the short opposite-stroke escape are heuristics. Matching an expected history
entry cannot prove which request caused a racing traversal, or distinguish every
inertial rebound from a new stroke. Physical-device testing is required for inertia
and rapid repeated gestures. Native Safari page snapshots and interactive
page-swipe animations are not implemented.

On Windows and Linux, browser commands from compatible mice, keyboards, or drivers
are forwarded through the same active-document and dialog guards. This does not
prove that a specific Windows touchpad driver produces those commands. The
application-level horizontal scrolling handler is available independently of that
driver behavior.

Electron's legacy `swipe` event handles three-finger gestures and is not used.
Enabling Chromium overscroll flags cannot supply the missing Electron embedder
integration, so no global command-line flags are added.

## Acceptance

Browser fixtures cover history changes, guards, cancellation, configuration and
lifecycle cleanup. They do not qualify physical touchpad behavior.

Before release, test a built package with a physical macOS trackpad and a Windows
Precision Touchpad:

- Visit at least three pages and navigate Back and Forward with two fingers.
- Confirm direction under the existing OS scrolling settings.
- Check long inertial tails, rapid repeated swipes, and direction reversal.
- Scroll an album carousel at both edges, drag volume/seek/EQ controls, and open
  Downloader or Equalizer. Those interactions must not leave the current page.
- Disable the Navigation menu checkbox, then disable and re-enable the plugin.
  Confirm gestures stop and resume once, without duplicate transitions.

Implementation references: [Electron overscroll delegate](https://github.com/electron/electron/blob/v42.10.0/shell/browser/api/electron_api_web_contents.cc),
[Electron window events](https://github.com/electron/electron/blob/v42.10.0/docs/api/browser-window.md),
and [Chrome's macOS history swiper](https://github.com/chromium/chromium/blob/148.0.7778.280/chrome/browser/renderer_host/chrome_render_widget_host_view_mac_history_swiper.mm).
