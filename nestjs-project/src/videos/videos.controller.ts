import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteVideoDto } from './dto/complete-video.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { CreatedVideoResponseDto } from './dto/created-video-response.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import { SignedPartsResponseDto } from './dto/signed-parts-response.dto';
import { UploadProgressResponseDto } from './dto/upload-progress-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Validates the declared size, opens the multipart upload in the storage and registers the video as a draft in the channel of the user.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created, with the plan of parts to upload',
    type: CreatedVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size exceeds the 10 GiB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreatedVideoResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':publicId')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Returns the video of the authenticated owner, including its status, so that the client can poll the processing.',
  })
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiResponse({
    status: 200,
    description: 'The video resource',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The video does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwned(publicId, user.sub);
  }

  @Post(':publicId/parts/sign')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign upload parts',
    description:
      'Returns presigned URLs valid for 1 hour. The client sends each part with a PUT on its URL and keeps the ETag header of the response.',
  })
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiResponse({
    status: 200,
    description: 'The presigned URLs of the requested parts',
    type: SignedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, or a part number exceeds the part count',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The video does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is no longer a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: SignPartsDto,
  ): Promise<SignedPartsResponseDto> {
    return this.videosService.signParts(publicId, user.sub, dto);
  }

  @Get(':publicId/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the upload progress',
    description:
      'Returns the parts that already reached the storage, with their ETags, and the part numbers still missing, so that the client can resume the upload.',
  })
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiResponse({
    status: 200,
    description: 'The uploaded parts and the part numbers still missing',
    type: UploadProgressResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The video does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'The video is no longer a draft, or its multipart upload no longer exists',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadProgress(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadProgressResponseDto> {
    return this.videosService.getUploadProgress(publicId, user.sub);
  }

  @Post(':publicId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Verifies the parts that reached the storage against the list sent by the client, closes the multipart upload and enqueues the processing. Repeating the call is safe and returns the current state of the video.',
  })
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiResponse({
    status: 200,
    description: 'The video resource, with its current status',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The video does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'The uploaded parts do not match the declared file, or the multipart upload no longer exists and the final object has not the declared size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'The uploaded parts exceed the 10 GiB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteVideoDto,
  ): Promise<VideoResponseDto> {
    return this.videosService.complete(publicId, user.sub, dto);
  }
}
