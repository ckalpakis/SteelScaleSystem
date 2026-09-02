export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface BookingToolInput {
  customerName: string;
  phoneNumber: string;
  address: string;
  service: string;
  preferredTime: string;
}

export interface LlmReply {
  text: string;
  toolCall?: {
    id: string;
    name: 'create_booking';
    input: BookingToolInput;
  };
}
