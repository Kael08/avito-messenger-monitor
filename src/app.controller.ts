import { Controller, Get, Post, Body } from '@nestjs/common';
import { AppService } from './app.service';
import { PuppeteerService } from './puppeteer/puppeteer.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly puppeteerService: PuppeteerService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  healthCheck() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('status')
  getStatus() {
    return this.puppeteerService.getStatus();
  }

  @Post('start')
  async startMonitoring() {
    try {
      await this.puppeteerService.startMonitoring();
      return { success: true, message: 'Monitoring started' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @Post('stop')
  async stopMonitoring() {
    try {
      await this.puppeteerService.stopMonitoring();
      return { success: true, message: 'Monitoring stopped' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}