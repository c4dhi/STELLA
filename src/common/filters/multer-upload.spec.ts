import { Controller, INestApplication, Module, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from './http-exception.filter';

/**
 * End to end with the real multer: a wrong upload field name must stay a 400 and
 * an oversized file a 413. multer 2.4.0 reworded the unexpected-field message,
 * which made @nestjs/platform-express (it matches on the text) answer 500.
 */
@Controller()
class UploadController {
  @Post('up')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 } }))
  up(@UploadedFile() file: unknown) {
    return { ok: !!file };
  }
}

@Module({ controllers: [UploadController] })
class UploadModule {}

describe('upload errors over HTTP (real multer)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [UploadModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  const upload = async (field: string, size: number) => {
    const form = new FormData();
    form.append(field, new Blob(['x'.repeat(size)]), 'a.txt');
    const res = await fetch(`${url}/up`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  };

  it('wrong field name -> 400, not 500', async () => {
    expect((await upload('wrongfield', 3)).status).toBe(400);
  });

  it('file too large -> 413', async () => {
    expect((await upload('file', 100)).status).toBe(413);
  });

  it('a valid upload still works', async () => {
    const { status, body } = await upload('file', 3);
    expect(status).toBe(201);
    expect(body.ok).toBe(true);
  });
});
