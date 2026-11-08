import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ type: 'integer', example: 1 })
  part_number: number;

  @ApiProperty({ example: '"7778aef83f66abc1fa1e8477f296d394"' })
  etag: string;
}

export class UploadProgressResponseDto {
  @ApiProperty({ type: 'integer', example: 16777216 })
  part_size: number;

  @ApiProperty({ type: 'integer', example: 2 })
  part_count: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];

  @ApiProperty({ type: 'integer', isArray: true, example: [2] })
  missing_part_numbers: number[];
}
