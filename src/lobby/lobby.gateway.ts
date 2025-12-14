import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

type JoinLobbyPayload = {
  username: string;
};

type ChatMessagePayload = {
  from: string;
  message: string;
}

type Player = {
  socketId: string;
  username: string;
  role?: Role;
  alive: boolean;
};

type Room = {
  id: string;
  players: Map<string, Player>;
  hostSocketId: string;
  phase: 'lobby' | 'night' | 'day' | 'ended';
  timer?: NodeJS.Timeout;
  winner?: 'mafia' | 'town';
};

type Role = {
  roleName: 'mafia' | 'detective' | 'doctor' | 'citizen';
  team: 'mafia' | 'town';
}

const ROLES = {
  mafia: { roleName: 'mafia', team: 'mafia' },
  detective: { roleName: 'detective', team: 'town' },
  doctor: { roleName: 'doctor', team: 'town' },
  citizen: { roleName: 'citizen', team: 'town' },
} as const;

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
      alive: true
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
    if (!(room.phase === 'lobby')) return;

    room.players.set(client.id, {
      socketId: client.id,
      username: payload.username,
      alive: true
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
    if (!player.alive) return;

    const chatMessage : ChatMessagePayload = {
      from: player.username,
      message: payload.message
    }

    this.server.to(roomId).emit('chat_message', chatMessage);
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

    this.assignRoles(room);
    this.emitRoles(room);

    this.emitSystem(roomId, `${player.username} started the game`);
    this.setPhase(roomId, 'night');
  }

  private checkWinCondition(room: Room): 'mafia' | 'town' | null {
    const alivePlayers = [...room.players.values()].filter(p => p.alive);
  
    const mafiaAlive = alivePlayers.filter(p => p.role?.team === 'mafia').length;
    const townAlive = alivePlayers.length - mafiaAlive;
  
    if (mafiaAlive === 0) return 'town';
    if (mafiaAlive >= townAlive) return 'mafia';
  
    return null;
  }

  private setPhase(roomId: string, phase: 'night' | 'day') {

    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.phase === 'ended') return;

    const winner = this.checkWinCondition(room);
    if (winner) {
      this.endGame(roomId, winner);
      return;
    }    
  
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

  private endGame(roomId: string, winner: 'mafia' | 'town') {
    const room = this.rooms.get(roomId);
    if (!room) return;
  
    if (room.timer) clearTimeout(room.timer);
  
    room.phase = 'ended';
    room.winner = winner;
  
    room.players.forEach(p => {
      p.role = undefined;
    });
  
    this.server.to(roomId).emit('game_over', { winner });
  }
  
  private assignRoles(room: Room) {
    const players = [...room.players.values()];

    if (players.some(p => p.role)) {
      return; // roles already assigned
    }
    
    const shuffled = [...players].sort(() => Math.random() - 0.5);

    shuffled.forEach(p => {
      p.alive = true;
    });
  
    const mafiaCount = Math.max(1, Math.floor(players.length / 4));
    const detectiveCount = players.length >= 4 ? 1 : 0;
    const doctorCount = players.length >= 5 ? 1 : 0;
  
    let index = 0;
  
    for (let i = 0; i < mafiaCount; i++, index++) {
      shuffled[index].role = ROLES.mafia;
    }
  
    for (let i = 0; i < detectiveCount; i++, index++) {
      shuffled[index].role = ROLES.detective;
    }
  
    for (let i = 0; i < doctorCount; i++, index++) {
      shuffled[index].role = ROLES.doctor;
    }
  
    for (; index < shuffled.length; index++) {
      shuffled[index].role = ROLES.citizen;
    }
  }  

  private emitRoles(room: Room) {
    for (const player of room.players.values()) {
      this.server.to(player.socketId).emit('role_assigned', {
        role: player.role,
      });
    }
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
