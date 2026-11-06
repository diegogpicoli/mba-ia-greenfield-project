export class VideoFileRejectedError extends Error {
  constructor(reason: string) {
    super(`Video file rejected: ${reason}`);
    this.name = 'VideoFileRejectedError';
  }
}

export class MediaCommandError extends Error {
  constructor(command: string, detail: string) {
    super(`${command} failed: ${detail}`);
    this.name = 'MediaCommandError';
  }
}
