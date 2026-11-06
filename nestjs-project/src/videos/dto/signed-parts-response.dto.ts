import { ApiProperty } from '@nestjs/swagger';

export class SignedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ format: 'uri' })
  url: string;
}

export class SignedPartsResponseDto {
  @ApiProperty({ type: [SignedPartDto] })
  parts: SignedPartDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  expires_at: Date;
}
