import { describe, expect, it } from 'vitest';
import { applyDeploymentDefaults, DEFAULTED_MARKER } from './deployment-defaults.js';

const up = async (): Promise<boolean> => true;
const down = async (): Promise<boolean> => false;

describe('what production left out', () => {
  it('fills in the address, the sender and a Redis that answers', async () => {
    const env: NodeJS.ProcessEnv = { XETRAL_ENVIRONMENT: 'production', NOTIFICATION_FROM: '' };
    const applied = await applyDeploymentDefaults(env, up);
    expect(applied).toEqual(['APP_BASE_URL', 'NOTIFICATION_FROM', 'REDIS_URL']);
    expect(env['APP_BASE_URL']).toBe('https://app.xetral.com');
    expect(env['NOTIFICATION_FROM']).toBe('Xetral <no-reply@xetral.com>');
    expect(env['REDIS_URL']).toBe('redis://redis:6379');
    expect(env[DEFAULTED_MARKER]).toBe('APP_BASE_URL,NOTIFICATION_FROM,REDIS_URL');
  });

  it('never points the limiter at a Redis nothing answers on', async () => {
    const env: NodeJS.ProcessEnv = { XETRAL_ENVIRONMENT: 'production' };
    await applyDeploymentDefaults(env, down);
    expect(env['REDIS_URL']).toBeUndefined();
  });

  it('leaves a value somebody set alone', async () => {
    const env: NodeJS.ProcessEnv = {
      XETRAL_ENVIRONMENT: 'production',
      APP_BASE_URL: 'https://pay.example.com',
    };
    await applyDeploymentDefaults(env, down);
    expect(env['APP_BASE_URL']).toBe('https://pay.example.com');
  });

  it('does nothing outside production', async () => {
    for (const environment of ['staging', 'development']) {
      const env: NodeJS.ProcessEnv = { XETRAL_ENVIRONMENT: environment };
      expect(await applyDeploymentDefaults(env, up)).toEqual([]);
      expect(env['APP_BASE_URL']).toBeUndefined();
    }
  });
});
