import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import {
  MediaCommandError,
  VideoFileRejectedError,
} from './video-media.errors';
import {
  MEDIA_ALLOWED_FORMATS,
  MEDIA_ALLOWED_PROTOCOLS,
  MEDIA_IO_TIMEOUT_MICROSECONDS,
  MEDIA_STDERR_MAX_LENGTH,
  REJECTED_FILE_STDERR_MARKERS,
  THUMBNAIL_POSITION_RATIO,
} from './videos.constants';

export interface VideoMetadata {
  duration: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: number | null;
  container: string | null;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; bit_rate?: string; format_name?: string };
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const INPUT_OPTIONS = [
  '-protocol_whitelist',
  MEDIA_ALLOWED_PROTOCOLS,
  '-format_whitelist',
  MEDIA_ALLOWED_FORMATS,
  '-rw_timeout',
  String(MEDIA_IO_TIMEOUT_MICROSECONDS),
];

function toNumberOrNull(value: string | undefined): number | null {
  const parsed = Number(value);
  return value === undefined || Number.isNaN(parsed) ? null : parsed;
}

export function parseProbeOutput(stdout: string): VideoMetadata {
  const { streams = [], format = {} } = JSON.parse(stdout) as ProbeOutput;
  const video = streams.find(
    (stream) =>
      stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  if (!video) {
    throw new VideoFileRejectedError('no video stream');
  }
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    duration: toNumberOrNull(format.duration) ?? toNumberOrNull(video.duration),
    width: video.width ?? null,
    height: video.height ?? null,
    video_codec: video.codec_name ?? null,
    audio_codec: audio?.codec_name ?? null,
    bitrate: toNumberOrNull(format.bit_rate),
    container: format.format_name ?? null,
  };
}

export function thumbnailPosition(duration: number | null): number {
  return duration === null ? 0 : duration * THUMBNAIL_POSITION_RATIO;
}

export function isRejectedFileFailure(stderr: string): boolean {
  return REJECTED_FILE_STDERR_MARKERS.some((marker) => stderr.includes(marker));
}

function describeFailure(stderr: string): string {
  return stderr.replace(/https?:\/\/\S+/g, '<url>').trim();
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MEDIA_STDERR_MAX_LENGTH);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr }),
    );
  });
}

async function fileHasContent(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

@Injectable()
export class VideoMediaService {
  async probe(url: string): Promise<VideoMetadata> {
    const { code, stdout, stderr } = await runCommand('ffprobe', [
      '-v',
      'error',
      ...INPUT_OPTIONS,
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      url,
    ]);
    if (code === 0) {
      return parseProbeOutput(stdout);
    }
    if (isRejectedFileFailure(stderr)) {
      throw new VideoFileRejectedError(describeFailure(stderr));
    }
    throw new MediaCommandError('ffprobe', describeFailure(stderr));
  }

  async extractThumbnail(
    url: string,
    duration: number | null,
    outputPath: string,
  ): Promise<void> {
    for (const position of [thumbnailPosition(duration), 0]) {
      await this.writeFrame(url, position, outputPath);
      if (await fileHasContent(outputPath)) {
        return;
      }
    }
    throw new MediaCommandError('ffmpeg', 'no frame was written');
  }

  private async writeFrame(
    url: string,
    position: number,
    outputPath: string,
  ): Promise<void> {
    const { code, stderr } = await runCommand('ffmpeg', [
      '-v',
      'error',
      ...INPUT_OPTIONS,
      '-ss',
      String(position),
      '-i',
      url,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-y',
      outputPath,
    ]);
    if (code !== 0) {
      throw new MediaCommandError('ffmpeg', describeFailure(stderr));
    }
  }
}
