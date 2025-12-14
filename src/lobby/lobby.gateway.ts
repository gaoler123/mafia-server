import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

type JoinLobbyPayload = {
  username: string;
};

type ChatMessagePayload = {
  message: string;
}

type Player = {
  socketId: string;
  username: string;
};

type Room = {
  id: string;
  players: Map<string, Player>;
  hostSocketId: string;
  phase: 'lobby' | 'night' | 'day';
  timer?: NodeJS.Timeout;
};

@WebSocketGateway({
  cors: {
    origin: '*'
  },
})
export class LobbyGateway implements OnGatewayConnection, OnGatewayDisconnect {

  @WebSocketServer()
  server: Server;
  users: number = 0;
  private rooms: Map<string, Room> = new Map();

  handleConnection(client: Socket, ...args: any[]) {
    console.log(`A user connected with ID: ${client.id}`);
    this.users++;
    console.log(`Number of users: ${this.users}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`A user disconnected with ID: ${client.id}`);
    this.users--;
    console.log(`Number of users: ${this.users}`);
  }

  @SubscribeMessage('create_room')
  handleCreateRoomEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinLobbyPayload
  ) {
    const roomId = this.generateRoomId();

    const room: Room = {
      id: roomId,
      players: new Map(),
      hostSocketId: client.id,
      phase: 'lobby',
    };

    room.players.set(client.id, {
      socketId: client.id,
      username: payload.username,
    });

    this.rooms.set(roomId, room);
    client.join(roomId);

    client.emit('room_joined', { roomId });

    this.emitRoomState(roomId);
    this.emitSystem(roomId, `${payload.username} created the room`);
  }


  @SubscribeMessage('join_room')
  handleJoinRoom(
    @MessageBody() payload: { roomId: string; username: string },
    @ConnectedSocket() client: Socket
  ) {
    const room = this.rooms.get(payload.roomId);
    if (!room) return;

    room.players.set(client.id, {
      socketId: client.id,
      username: payload.username,
    });

    client.join(payload.roomId);
    client.emit('room_joined', { roomId: payload.roomId });

    this.emitRoomState(payload.roomId);
    this.emitSystem(payload.roomId, `${payload.username} joined the lobby`);
  }

  @SubscribeMessage('leave_room')
  handleLeaveRoom(@ConnectedSocket() client: Socket) {
    const roomId = this.findRoomBySocket(client.id);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    const player = room.players.get(client.id);
    if (!player) return;

    room.players.delete(client.id);
    client.leave(roomId);

    // Host leaves → reassign or destroy room
    if (client.id === room.hostSocketId) {
      const nextHost = room.players.keys().next().value;
      room.hostSocketId = nextHost ?? '';
    }

    if (room.players.size === 0) {
      if (room.timer) {
        clearTimeout(room.timer);
      }
      this.rooms.delete(roomId);
      return;
    }

    this.emitRoomState(roomId);
    this.emitSystem(roomId, `${player.username} left the lobby`);
  }

  private findRoomBySocket(socketId: string): string | undefined {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.players.has(socketId)) {
        return roomId;
      }
    }
  }  
  @SubscribeMessage('chat_message')
  handleChatMessage(
    @MessageBody() payload: { message: string },
    @ConnectedSocket() client: Socket
  ) {
    const roomId = this.findRoomBySocket(client.id);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    const player = room.players.get(client.id);
    if (!player) return;

    this.server.to(roomId).emit('chat_message', {
      from: player.username,
      message: payload.message,
    });
  }

  @SubscribeMessage('start_game')
  handleStartGame(
    @ConnectedSocket() client: Socket
  ) {
    
    const roomId = this.findRoomBySocket(client.id);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.phase !== 'lobby') return;

    const player = room.players.get(client.id);
    if (!player) return;

    if (!(room.hostSocketId === player.socketId)) return;

    this.emitSystem(roomId, `${player.username} started the game`);
    this.setPhase(roomId, 'night');
  }

  private setPhase(roomId: string, phase: 'night' | 'day') {
    const room = this.rooms.get(roomId);
    if (!room) return;
  
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = undefined;
    }
  
    room.phase = phase;

    this.emitSystem(roomId, `Phase changed to ${phase}`);
    this.emitRoomState(roomId);
  
    const duration =
      phase === 'night' ? 30_000 : 60_000;    
  
    room.timer = setTimeout(() => {
      const nextPhase = phase === 'night' ? 'day' : 'night';
      this.setPhase(roomId, nextPhase);
    }, duration);
  }
  

  private emitRoomState(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
  
    this.server.to(roomId).emit('room_state', {
      roomId,
      phase: room.phase,
      players: [...room.players.values()].map(p => ({
        username: p.username,
        isHost: p.socketId === room.hostSocketId,
      })),
    });
  }
  
  private emitSystem(roomId: string, message: string) {
    this.server.to(roomId).emit('system_message', { message });
  }
  
  private generateRoomId(): string {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
  }
}
