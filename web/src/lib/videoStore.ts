// The local game video (F12). Kept in memory for this tab only: never uploaded, never stored.
let file: File | null = null;

export function setVideoFile(f: File | null) { file = f; }
export function getVideoFile(): File | null { return file; }
