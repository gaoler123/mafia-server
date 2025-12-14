import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { RoomManager } from 'src/room/room.manager';
import { PhaseService } from 'src/game/phase.service';
import { generateRoomId } from '../utils/id.utils';

import { Room } from '../types/room.types';
import { VotingService } from 'src/game/voting.service';
import { WinService } from 'src/game/win.service';

@WebSocketGateway({ cors: { origin: '*' } })
export class LobbyGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private roomManager = new RoomManager();
  private phaseService = new PhaseService();
  private votingService = new VotingService();
  private winService = new WinService()
  private users = 0;

  /* ---------------------------------- */
  /* Connection lifecycle               */
  /* ---------------------------------- */

  handleConnection(client: Socket) {
    this.users++;
    console.log(`Connected: ${client.id} | users=${this.users}`);
  }

  handleDisconnect(client: Socket) {
    this.users--;
    console.log(`Disconnected: ${client.id} | users=${this.users}`);
  }

  /* ---------------------------------- */
  /* Room management                    */
  /* ---------------------------------- */

  @SubscribeMessage('create_room')
  handleCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { username: string }
  ) {
    const roomId = generateRoomId();

    const room: Room = {
      id: roomId,
      players: new Map(),
      hostSocketId: client.id,
      phase: 'lobby',
    };

    room.players.set(client.id, {
      socketId: client.id,
      username: payload.username,
      alive: true,
    });

    this.roomManager.set(room);
    client.join(roomId);

    client.emit('room_joined', { roomId });
    this.emitRoomState(roomId);
    this.emitSystem(roomId, `${payload.username} created the room`);
  }

  @SubscribeMessage('join_room')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { roomId: string; username: string }
  ) {
    const room = this.roomManager.get(payload.roomId);
    if (!room || room.phase !== 'lobby') return;

    room.players.set(client.id, {
      socketId: client.id,
      username: payload.username,
      alive: true,
    });

    client.join(payload.roomId);
    client.emit('room_joined', { roomId: payload.roomId });

    this.emitRoomState(payload.roomId);
    this.emitSystem(payload.roomId, `${payload.username} joined the lobby`);
  }

  @SubscribeMessage('leave_room')
  handleLeaveRoom(@ConnectedSocket() client: Socket) {
    const room = this.roomManager.findBySocket(client.id);
    if (!room) return;

    const player = room.players.get(client.id);
    if (!player) return;

    room.players.delete(client.id);
    client.leave(room.id);

    if (client.id === room.hostSocketId) {
      room.hostSocketId = room.players.keys().next().value ?? '';
    }

    if (room.players.size === 0) {
      this.phaseService.end(room, room.winner ?? 'town');
      this.roomManager.delete(room.id);
      return;
    }

    this.emitRoomState(room.id);
    this.emitSystem(room.id, `${player.username} left the lobby`);
  }

  /* ---------------------------------- */
  /* Chat                               */
  /* ---------------------------------- */

  @SubscribeMessage('chat_message')
  handleChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { message: string }
  ) {
    const room = this.roomManager.findBySocket(client.id);
    if (!room) return;

    const player = room.players.get(client.id);
    if (!player || !player.alive) return;

    this.server.to(room.id).emit('chat_message', {
      from: player.username,
      message: payload.message,
    });
  }

  /* ---------------------------------- */
  /* Game start                         */
  /* ---------------------------------- */

  @SubscribeMessage('start_game')
  handleStartGame(@ConnectedSocket() client: Socket) {
    const room = this.roomManager.findBySocket(client.id);
    if (!room || room.phase !== 'lobby') return;

    const player = room.players.get(client.id);
    if (!player || room.hostSocketId !== client.id) return;

    this.assignRoles(room);
    this.emitRoles(room);

    this.emitSystem(room.id, `${player.username} started the game`);

    this.phaseService.startPhase(
      room,
      'night',
      () => this.winService.check(room),
      () => this.resolveDay(room),
      () => this.emitRoomState(room.id)
    );
    

    this.emitRoomState(room.id);
  }

  /* ---------------------------------- */
  /* Voting                             */
  /* ---------------------------------- */

  @SubscribeMessage('vote_player')
  handleVote(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { target: string }
  ) {
    const room = this.roomManager.findBySocket(client.id);
    if (!room || room.phase !== 'day' || room.dayStage !== 'voting') return;

    const voter = room.players.get(client.id);
    if (!voter || !voter.alive) return;

    const target = [...room.players.values()].find(
      p => p.username === payload.target && p.alive
    );
    if (!target || target.socketId === client.id) return;

    this.votingService.vote(room, client.id, target.socketId);

    this.emitVoteState(room);
  }

  /* ---------------------------------- */
  /* Resolution helpers                 */
  /* ---------------------------------- */

  private resolveDay(room: Room) {
    const result = this.votingService.resolve(room);
    if (result) this.emitSystem(room.id, result);
    this.emitRoomState(room.id);
  }
  
  /* ---------------------------------- */
  /* Emits                              */
  /* ---------------------------------- */

  private emitRoomState(roomId: string) {
    const room = this.roomManager.get(roomId);
    if (!room) return;

    this.server.to(roomId).emit('room_state', {
      roomId,
      phase: room.phase,
      dayStage: room.dayStage,
      players: [...room.players.values()].map(p => ({
        username: p.username,
        isHost: p.socketId === room.hostSocketId,
      })),
    });
  }

  private emitSystem(roomId: string, message: string) {
    this.server.to(roomId).emit('system_message', { message });
  }

  private emitRoles(room: Room) {
    for (const player of room.players.values()) {
      this.server.to(player.socketId).emit('role_assigned', {
        role: player.role,
      });
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

      tally[target.username] = (tally[target.username] ?? 0) + 1;
      votes.push({ from: voter.username, to: target.username });
    }

    this.server.to(room.id).emit('vote_update', {
      tally,
      votes,
      totalVoters: room.votes.size,
    });
  }

  /* ---------------------------------- */
  /* Roles                              */
  /* ---------------------------------- */

  private assignRoles(room: Room) {
    const players = [...room.players.values()];
    if (players.some(p => p.role)) return;

    players.sort(() => Math.random() - 0.5);
    players.forEach(p => (p.alive = true));

    const mafiaCount = Math.max(1, Math.floor(players.length / 4));

    players.forEach((p, i) => {
      if (i < mafiaCount) p.role = { roleName: 'mafia', team: 'mafia' };
      else if (i === mafiaCount) p.role = { roleName: 'detective', team: 'town' };
      else if (i === mafiaCount + 1)
        p.role = { roleName: 'doctor', team: 'town' };
      else p.role = { roleName: 'citizen', team: 'town' };
    });
  }
}
