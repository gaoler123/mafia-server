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
  dayStage?: 'discussion' | 'voting';
  timer?: NodeJS.Timeout;
  dayStageTimer?: NodeJS.Timeout;
  winner?: 'mafia' | 'town';
  votes?: Map<string, string>; // voterSocketId -> targetSocketId
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

    @SubscribeMessage('vote_player')
    handleVote(
      @MessageBody() payload: { target: string },
      @ConnectedSocket() client: Socket
    ) {
    const roomId = this.findRoomBySocket(client.id);
    if (!roomId) return;

    const room = this.rooms.get(roomId);

    if (
      !room ||
      room.phase !== 'day' ||
      room.dayStage !== 'voting'
    ) return;
    
    const voter = room.players.get(client.id);
    if (!voter || !voter.alive) return;

    const target = [...room.players.values()]
      .find(p => p.username === payload.target);

    if (!target || !target.alive) return;
    if (target.socketId === client.id) return;

    room.votes ??= new Map();
    room.votes.set(client.id, target.socketId);

    this.emitVoteState(room);
  }

  private setPhase(roomId: string, phase: 'night' | 'day') {
    const room = this.rooms.get(roomId);
    if (!room || room.phase === 'ended') return;
  
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
  
    if (phase === 'day') {
      room.dayStage = 'discussion';
      room.votes = undefined;
    
      this.emitSystem(roomId, "Day has begun. Discuss!");
    
      room.dayStageTimer = setTimeout(() => {
        if (room.phase !== 'day') return;
    
        room.dayStage = 'voting';
        room.votes = new Map();
    
        this.emitSystem(roomId, "Voting has started!");
        this.emitRoomState(roomId);
      }, 30_000);
    } else {
      room.dayStage = undefined;
      room.votes = undefined;
    }
      
    this.emitRoomState(roomId);
  
    const duration = phase === 'night' ? 30_000 : 60_000;
  
    room.timer = setTimeout(() => {
      if (phase === 'day') {
        this.resolveVotes(room);
      }
      const nextPhase = phase === 'night' ? 'day' : 'night';
      this.setPhase(roomId, nextPhase);
      if (room.dayStageTimer) {
        clearTimeout(room.dayStageTimer);
        room.dayStageTimer = undefined;
      }      
    }, duration);
  }
  

  private endGame(roomId: string, winner: 'mafia' | 'town') {
    const room = this.rooms.get(roomId);
    if (!room) return;
  
    if (room.timer) clearTimeout(room.timer);
    if (room.dayStageTimer) clearTimeout(room.dayStageTimer);
  
    room.timer = undefined;
    room.dayStageTimer = undefined;
  
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

  private emitVoteState(room: Room) {
    if (!room.votes) return;
  
    const tally: Record<string, number> = {};
    const votes: { from: string; to: string }[] = [];
  
    for (const [voterId, targetId] of room.votes.entries()) {
      const voter = room.players.get(voterId);
      const target = room.players.get(targetId);
  
      if (!voter || !target) continue;
  
      // tally
      tally[target.username] = (tally[target.username] ?? 0) + 1;
  
      // explicit mapping
      votes.push({
        from: voter.username,
        to: target.username,
      });
    }
  
    this.server.to(room.id).emit('vote_update', {
      tally,
      votes,
      totalVoters: room.votes.size,
    });
  }  

  private resolveVotes(room: Room) {
    if (!room.votes || room.votes.size === 0) {
      this.emitSystem(room.id, "No votes cast. Nobody was eliminated.");
      return;
    }

    const counts = new Map<string, number>();

    for (const targetId of room.votes.values()) {
      counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
      this.emitSystem(room.id, "Vote tied. Nobody was eliminated.");
      return;
    }

    const [loserId] = sorted[0];
    const victim = room.players.get(loserId);
    if (!victim) return;

    victim.alive = false;
    this.emitSystem(room.id, `${victim.username} was eliminated`);
    this.emitRoomState(room.id);

    const winner = this.checkWinCondition(room);
    if (winner) {
      this.endGame(room.id, winner);
    }

    room.votes = undefined;
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
      dayStage: room.dayStage,
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
