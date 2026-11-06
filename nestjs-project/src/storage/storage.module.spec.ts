import { Injectable } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

@Injectable()
class StorageConsumer {
  constructor(readonly storage: StorageService) {}
}

describe('StorageModule', () => {
  it('should compile and export StorageService to its consumers', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [StorageConsumer],
    }).compile();

    expect(module.get(StorageConsumer).storage).toBeInstanceOf(StorageService);
    await module.close();
  }, 30000);
});
