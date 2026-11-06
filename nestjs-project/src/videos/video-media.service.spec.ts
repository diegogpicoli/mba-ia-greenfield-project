import { VideoFileRejectedError } from './video-media.errors';
import {
  isRejectedFileFailure,
  parseProbeOutput,
  thumbnailPosition,
} from './video-media.service';

const VIDEO_STREAM = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 640,
  height: 360,
  duration: '5.000000',
  disposition: { attached_pic: 0 },
};
const AUDIO_STREAM = {
  codec_type: 'audio',
  codec_name: 'aac',
  duration: '5.000000',
  disposition: { attached_pic: 0 },
};
const FORMAT = {
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration: '5.000000',
  bit_rate: '129400',
};

function probeJson(streams: object[], format: object = FORMAT): string {
  return JSON.stringify({ streams, format });
}

describe('VideoMediaService helpers', () => {
  describe('parseProbeOutput', () => {
    it('should read the metadata of a video with audio', () => {
      expect(parseProbeOutput(probeJson([VIDEO_STREAM, AUDIO_STREAM]))).toEqual(
        {
          duration: 5,
          width: 640,
          height: 360,
          video_codec: 'h264',
          audio_codec: 'aac',
          bitrate: 129400,
          container: 'mov,mp4,m4a,3gp,3g2,mj2',
        },
      );
    });

    it('should return a null audio codec when there is no audio stream', () => {
      expect(
        parseProbeOutput(probeJson([VIDEO_STREAM])).audio_codec,
      ).toBeNull();
    });

    it('should fall back to the video stream duration when the format has none', () => {
      const output = probeJson([VIDEO_STREAM], { format_name: 'matroska' });

      expect(parseProbeOutput(output).duration).toBe(5);
    });

    it('should return null for values that ffprobe reports as N/A', () => {
      const output = probeJson([{ ...VIDEO_STREAM, duration: 'N/A' }], {
        format_name: 'matroska',
        duration: 'N/A',
        bit_rate: 'N/A',
      });

      expect(parseProbeOutput(output)).toMatchObject({
        duration: null,
        bitrate: null,
      });
    });

    it('should reject a file without a video stream', () => {
      expect(() => parseProbeOutput(probeJson([AUDIO_STREAM]))).toThrow(
        VideoFileRejectedError,
      );
    });

    it('should reject an audio file whose only video stream is the cover art', () => {
      const cover = {
        codec_type: 'video',
        codec_name: 'png',
        disposition: { attached_pic: 1 },
      };

      expect(() => parseProbeOutput(probeJson([AUDIO_STREAM, cover]))).toThrow(
        VideoFileRejectedError,
      );
    });
  });

  describe('thumbnailPosition', () => {
    it('should take the frame at 10% of the duration', () => {
      expect(thumbnailPosition(5)).toBeCloseTo(0.5);
    });

    it('should take the first frame when the duration is unknown', () => {
      expect(thumbnailPosition(null)).toBe(0);
    });
  });

  describe('isRejectedFileFailure', () => {
    it.each([
      'http://minio:9000/x: Invalid data found when processing input',
      "[file @ 0x1] Protocol 'file' not on whitelist 'http,https,tcp,tls'!",
      "[hls @ 0x1] Format not on whitelist 'mov,mp4'\nx: Invalid argument",
      "[concat @ 0x1] Unsafe file name 'file:///etc/passwd'\nx: Operation not permitted",
    ])('should treat %s as a problem with the file', (stderr) => {
      expect(isRejectedFileFailure(stderr)).toBe(true);
    });

    it.each([
      'http://minio:9000/x: Server returned 403 Forbidden (access denied)',
      'http://minio:9000/x: Server returned 404 Not Found',
      'http://minio:9000/x: Server returned 5XX Server Error reply',
      'http://minio:9000/x: Connection refused',
      'http://minio:9000/x: Input/output error',
      'http://minio:9000/x: Connection timed out',
    ])('should treat %s as a failure to reach the storage', (stderr) => {
      expect(isRejectedFileFailure(stderr)).toBe(false);
    });
  });
});
