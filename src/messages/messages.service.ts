import { Injectable } from '@nestjs/common';

export interface Message {
  id: string;
  text: string;
  sender: string;
  phoneNumber?: string;
  timestamp: string;
}

@Injectable()
export class MessagesService {
  private messages: Message[] = [];
  private listeners: Array<(message: Message) => void> = [];

  addMessage(message: Message): void {
    this.messages.push(message);
    
    // Уведомляем всех слушателей о новом сообщении
    this.listeners.forEach(listener => {
      try {
        listener(message);
      } catch (error) {
        console.error('Error notifying listener:', error);
      }
    });
  }

  getAllMessages(): Message[] {
    return [...this.messages];
  }

  subscribe(listener: (message: Message) => void): () => void {
    this.listeners.push(listener);
    
    // Возвращаем функцию для отписки
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  clearMessages(): void {
    this.messages = [];
  }
}
