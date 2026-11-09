import type { EqualizerProfile } from './config';

type StockPreset = Readonly<{ id: string; gains: readonly number[] }>;

const curves: readonly [string, readonly number[]][] = [
  ['flat', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['acoustic', [4.8, 4.5, 3.5, 0.4, 1.8, 1.6, 3.3, 3.8, 3.3, 1.3]],
  ['bass-booster', [5, 4, 3, 2.1, 1.1, -0.4, -0.4, -0.4, -0.4, -0.4]],
  ['bass-reducer', [-6.2, -4.5, -3.8, -3, -1.6, -0.4, -0.4, -0.4, -0.4, -0.4]],
  ['classical', [0, 0, 0, 0, 0, 0, 0, -1.5, -3.7, -5.3]],
  ['club', [0.1, 0.1, 2.3, 3.5, 3.5, 3.5, 2.6, 0.1, 0.1, 0.2]],
  ['dance', [6.8, 5.3, 4, 2, 0, 0, 0, -3.1, -3.1, 0]],
  ['deep', [4.5, 3, 1.3, 0.4, 2.3, 1.8, 1.1, -2.8, -4, -5]],
  ['electronic', [4, 3.5, 0.9, -0.6, -2.6, 1.8, 0.4, 0.9, 3.5, 4.3]],
  ['hip-hop', [4.5, 3.8, 0.9, 2.3, -1.3, -1.3, 1.1, -1.3, 1.8, 2.3]],
  ['jazz', [3.8, 2.3, 0.9, 1.8, -1.8, -1.8, -0.6, 1.1, 2.6, 3.5]],
  ['latin', [4, 2.3, -0.6, -0.6, -1.8, -1.8, -1.8, -0.4, 2.6, 4]],
  ['live', [-4.6, -2.9, -0.4, 1.8, 3.1, 3.7, 3.7, 2.6, 1.3, 0.4]],
  ['loudness', [5.2, 3.5, -0.6, -0.6, -2.6, -0.4, -1.6, -5.5, 4.5, 0.4]],
  ['lounge', [-3.5, -1.8, -1.1, 0.9, 3.5, 1.8, -0.4, -1.8, 1.8, 0.4]],
  ['metal', [-0.3, 2.9, 2.7, -0.7, -2.7, -3.1, 0, 3.1, 5.7, 2.9]],
  ['piano', [2.6, 1.6, -0.6, 2.1, 2.6, 0.6, 3.3, 4, 2.3, 3]],
  ['pop', [-2.4, -0.9, 1.8, 3.5, 4.6, 3.3, 1.5, 0, -0.9, -1.1]],
  ['reggae', [0, 0, 0, -1.3, -3.7, -0.7, 2, 3.3, 1.8, 0]],
  ['rnb', [2.1, 6.2, 5.5, 1.1, -2.8, -1.8, 2.1, 2.6, 2.3, 3.5]],
  ['rock', [5.9, 4.8, 1.5, -1.8, -4.6, -1.1, 2.6, 5.5, 6.6, 7]],
  ['ska', [-1.8, -3, -2.8, -0.4, 2.6, 3.5, 5.5, 6, 6.5, 6]],
  ['small-speakers', [4.8, 3.5, 3, 1.8, 0.4, -0.6, -1.6, -3, -4, -4.5]],
  ['soft', [3, 0.9, -0.9, -1.8, -1.1, 2.8, 5.2, 6, 6.5, 7.2]],
  ['soft-rock', [2.6, 2.6, 1.3, -0.4, -2.8, -3.5, -2.6, -0.4, 1.8, 2.6]],
  ['spoken-word', [-4.3, -1.1, -0.4, 0.1, 3, 4.3, 4.8, 3.8, 1.8, -0.6]],
  ['techno', [4.8, 3.5, 0.1, -3.5, -3, 0.1, 4.8, 6, 6, 5.7]],
  ['treble-booster', [-0.4, -0.4, -0.4, -0.4, -0.4, 0.6, 2.1, 3.3, 3.8, 5.2]],
  ['treble-reducer', [-0.4, -0.4, -0.4, -0.4, -0.4, -1.6, -3, -4, -4.8, -5.5]],
  ['vocal-booster', [-2.1, -3.3, -3.3, 0.9, 3.3, 3.3, 2.6, 1, -0.3, -2.1]],
];

// Fixed upstream curves are blueprints; active/user profiles are independent copies.
export const stockPresets: readonly StockPreset[] = Object.freeze(
  curves.map(([id, gains]) =>
    Object.freeze({ id, gains: Object.freeze(gains) }),
  ),
);
const frequencies = [
  32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const;

export function stockProfile(id: string): EqualizerProfile | null {
  const preset = stockPresets.find((value) => value.id === id);
  if (!preset) return null;
  const boost = Math.max(0, ...preset.gains);
  return {
    mode: 'custom',
    // Starting headroom only: overlapping bands can still boost above this offset.
    preamp: boost ? -boost : 0,
    bands: frequencies.map((frequency, i) => ({
      id: `stock-${id}-${i}`,
      type: 'peaking',
      frequency,
      Q: 1,
      gain: preset.gains[i],
    })),
  };
}
