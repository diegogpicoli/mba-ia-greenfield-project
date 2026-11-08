import { IsInt, IsString, Length, Min } from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @Length(1, 255)
  original_filename: string;

  @IsInt()
  @Min(1)
  declared_size: number;

  @IsString()
  @Length(1, 255)
  content_type: string;
}
