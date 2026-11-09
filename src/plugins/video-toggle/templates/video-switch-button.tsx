import { Show } from 'solid-js';

export interface VideoSwitchButtonProps {
  videoVisible: boolean;
  onVideoToggle: (showVideo: boolean) => void;
  songButtonText: string;
  videoButtonText: string;
}

export const VideoSwitchButton = (props: VideoSwitchButtonProps) => (
  <button
    aria-label={props.videoButtonText}
    aria-pressed={props.videoVisible}
    class="video-switch-button"
    on:click={(event) => {
      event.stopPropagation();
      props.onVideoToggle(!props.videoVisible);
    }}
    title={props.videoVisible ? props.songButtonText : props.videoButtonText}
    type="button"
  >
    <svg
      aria-hidden="true"
      fill="none"
      height="24"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
      width="24"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      <Show when={!props.videoVisible}>
        <path d="m3 3 18 18" />
      </Show>
    </svg>
  </button>
);
