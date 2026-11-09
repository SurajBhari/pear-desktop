export const stripMusicFromShareUrl = (value: string): string => {
  if (typeof value !== 'string' || value.length > 8192) return value;
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.hostname !== 'music.youtube.com' ||
      url.username ||
      url.password
    )
      return value;
    url.hostname = 'youtube.com';
    return url.href;
  } catch {
    return value;
  }
};
