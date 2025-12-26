import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PuppeteerService } from './puppeteer/puppeteer.service';
import { MessagesGateway } from './messages/messages.gateway';
import { MessagesService } from './messages/messages.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, PuppeteerService, MessagesGateway, MessagesService],
})
export class AppModule {}
