import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { VIDEO_MAX_PART_COUNT } from '../videos.constants';

export class CompletedPartDto {
  @IsInt()
  @Min(1)
  part_number: number;

  /** Value of the ETag header received on the PUT of the part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteVideoDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_MAX_PART_COUNT)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
