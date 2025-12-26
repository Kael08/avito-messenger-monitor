import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { MessagesService, Message } from './messages.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class MessagesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MessagesGateway.name);
  private unsubscribeFromMessages: (() => void) | null = null;

  constructor(private readonly messagesService: MessagesService) {
    // Подписываемся на новые сообщения при создании gateway
    this.subscribeToMessages();
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    
    // Отправляем все существующие сообщения новому клиенту
    const allMessages = this.messagesService.getAllMessages();
    client.emit('allMessages', allMessages);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket) {
    client.emit('pong', { timestamp: new Date().toISOString() });
  }

  private subscribeToMessages(): void {
    this.unsubscribeFromMessages = this.messagesService.subscribe((message: Message) => {
      // Отправляем новое сообщение всем подключенным клиентам
      this.server.emit('newMessage', message);
      this.logger.log(`Broadcasting new message: ${message.text.substring(0, 50)}...`);
    });
  }

  // Метод для отправки статуса мониторинга
  sendMonitoringStatus(status: { isRunning: boolean; message?: string; url?: string }) {
    this.server.emit('monitoringStatus', status);
  }
}
