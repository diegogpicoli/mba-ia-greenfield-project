import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface TestVideoOptions {
  width?: number;
  height?: number;
  durationSeconds?: number;
  video?: boolean;
  audio?: boolean;
  frames?: number;
  container?: 'mp4' | 'matroska' | 'mpegts';
  noise?: boolean;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with ${code}: ${stderr}`)),
    );
  });
}

/**
 * Generates a video with `ffmpeg -f lavfi`, so that no binary is committed.
 * In an MP4, the default index position is kept, at the end of the file, which
 * is the case that requires HTTP Range reads. With `noise`, the frames are
 * encoded without loss, at about 8 MiB per second of video in the default size,
 * for the cases that need a file with more than one upload part.
 */
export async function generateTestVideo({
  width = 640,
  height = 360,
  durationSeconds = 5,
  video = true,
  audio = true,
  frames,
  container = 'mp4',
  noise = false,
}: TestVideoOptions = {}): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'test-video-'));
  const output = join(directory, 'video');
  const inputs = [
    ...(video
      ? [
          '-f',
          'lavfi',
          '-i',
          `testsrc=size=${width}x${height}:rate=25:duration=${durationSeconds}${noise ? ',noise=alls=100:allf=t' : ''}`,
        ]
      : []),
    ...(audio
      ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`]
      : []),
  ];
  const encoders = [
    ...(video ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : []),
    ...(video && noise ? ['-preset', 'ultrafast', '-qp', '0'] : []),
    ...(audio ? ['-c:a', 'aac'] : []),
    ...(frames !== undefined ? ['-frames:v', String(frames)] : []),
  ];
  try {
    await runFfmpeg([...inputs, ...encoders, '-f', container, output]);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
