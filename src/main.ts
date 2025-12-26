import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { PuppeteerService } from './puppeteer/puppeteer.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  app.useStaticAssets(join(__dirname, '..', 'public'));

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  
  console.log(`Application is running on: http://localhost:${port}`);

  const puppeteerService = app.get(PuppeteerService);
  
  process.on('SIGINT', async () => {
    console.log('\nSIGINT received, shutting down gracefully...');
    await puppeteerService.stopMonitoring();
    await app.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nSIGTERM received, shutting down gracefully...');
    await puppeteerService.stopMonitoring();
    await app.close();
    process.exit(0);
  });

  process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await puppeteerService.stopMonitoring();
    await app.close();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await puppeteerService.stopMonitoring();
    await app.close();
    process.exit(1);
  });
}

bootstrap();