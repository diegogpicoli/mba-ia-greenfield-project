import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { VIDEO_MAX_PART_COUNT } from '../videos.constants';

export class SignPartsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_MAX_PART_COUNT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
