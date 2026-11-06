import { envValidationSchema } from './env.validation';

const queueAndStorageEnv = {
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
  S3_BUCKET_VIDEOS: 'videos',
  S3_BUCKET_THUMBNAILS: 'thumbnails',
};

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  ...queueAndStorageEnv,
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — queue and storage', () => {
  it.each(Object.keys(queueAndStorageEnv))(
    'should reject the environment when %s is missing',
    (key) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[key];

      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain(`"${key}" is required`);
    },
  );

  it('should accept the environment when every key is present', () => {
    const { error } = validate({});
    expect(error).toBeUndefined();
  });

  it.each(['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT'])(
    'should reject %s when it is not a URI',
    (key) => {
      const { error } = validate({ [key]: 'not a uri' });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject REDIS_PORT when it is not a port', () => {
    const { error } = validate({ REDIS_PORT: 'not-a-port' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    const value = result.value as { SWAGGER_ENABLED: string };
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});
