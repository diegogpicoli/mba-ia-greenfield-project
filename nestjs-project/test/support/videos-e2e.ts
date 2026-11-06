import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { MailService } from '../../src/mail/mail.service';

const PASSWORD = 'password123';

export async function createVideosTestApp(): Promise<{
  app: INestApplication<App>;
  moduleRef: TestingModule;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return { app, moduleRef };
}

export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
): Promise<string> {
  let confirmationToken = '';
  jest
    .spyOn(app.get(MailService), 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: PASSWORD })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (login.body as { access_token: string }).access_token;
}
