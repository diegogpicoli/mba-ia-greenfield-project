import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class CreatedVideoResponseDto {
  @ApiProperty({ example: 'Xk3vP9qLm2A' })
  public_id: string;

  @ApiProperty({ example: 'aula.mp4' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 'aula.mp4' })
  original_filename: string;

  @ApiProperty({ example: 20971520 })
  declared_size: number;

  @ApiProperty({ example: 16777216 })
  part_size: number;

  @ApiProperty({ example: 2 })
  part_count: number;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updated_at: Date;
}
