import { Room } from '../types/room.types';

export class RoomManager {
  private rooms = new Map<string, Room>();

  get(roomId: string) {
    return this.rooms.get(roomId);
  }

  set(room: Room) {
    this.rooms.set(room.id, room);
  }

  delete(roomId: string) {
    this.rooms.delete(roomId);
  }

  findBySocket(socketId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.players.has(socketId)) return room;
    }
  }
}
