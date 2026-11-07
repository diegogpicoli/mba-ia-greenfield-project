import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ example: 'Xk3vP9qLm2A' })
  public_id: string;

  @ApiProperty({ example: 'aula.mp4' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ example: 'aula.mp4' })
  original_filename: string;

  @ApiProperty({ type: 'integer', example: 20971520 })
  declared_size: number;

  @ApiProperty({ type: Number, nullable: true, example: 5 })
  duration: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 640 })
  width: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 360 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 129400 })
  bitrate: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  container: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uri' })
  thumbnail_url: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updated_at: Date;
}
