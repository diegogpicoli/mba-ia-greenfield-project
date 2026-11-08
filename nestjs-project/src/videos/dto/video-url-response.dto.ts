import { ApiProperty } from '@nestjs/swagger';

export class VideoUrlResponseDto {
  @ApiProperty({ format: 'uri' })
  url: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expires_at: Date;
}
